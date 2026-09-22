"use strict";
/**
 * Where a bot's build comes from.
 *
 * Bots are not handed a route - they are handed a personality, and they pick
 * their own talents from it, one level at a time, from whatever is legal at
 * that moment. That is what stops every Shaman looking the same, and it means
 * an eventual "the winners breed" generation step has something to mutate.
 */

const rules = require("./rules");
const stats = require("./stats");

/**
 * A bias is what the bot is trying to achieve, as weights over the four stats,
 * plus how much it likes each tree, plus how strictly it follows its own plan.
 *
 *   focus 0   - picks at random from whatever is available
 *   focus 1   - normal: usually takes the best thing for its bias
 *   focus 3   - tunnel vision, takes the best available almost every time
 */
function randomBias(trees, rng) {
  const bias = {};
  for (const s of stats.STATS) bias[s] = rng.range(0, 1);

  // Most people commit to a tree rather than sprinkling points evenly, so give
  // one tree a strong pull and let the others trail.
  const affinity = {};
  const favourite = rng.pick(trees).id;
  for (const t of trees) affinity[t.id] = t.id === favourite ? rng.range(0.6, 1) : rng.range(0, 0.45);

  return { stats: bias, affinity, focus: rng.range(0.6, 2.6), favourite };
}

/** How much this bot wants one more rank in this talent, right now. */
function appetite(bias, klass, tree, tal) {
  const w = stats.weights(klass).talents;
  const contrib = w[tal.id] || w[tal.name] || {};
  let value = 0;
  for (const s of stats.STATS) {
    if (contrib[s]) value += contrib[s] * bias.stats[s];
  }
  // scale into a comfortable range, then let tree loyalty shift it
  return value * 100 + bias.affinity[tree.id] * 0.35;
}

/**
 * Build a full route by choosing, at each point, from what is legal. Returns
 * fewer steps than maxPoints only if the tree genuinely runs out, which for a
 * 51-point Shaman it does not.
 */
function generate(klass, trees, maxPoints, bias, rng) {
  const st = rules.emptyState(trees);
  const route = [];

  for (let i = 0; i < maxPoints; i++) {
    const options = rules.learnable(trees, st);
    if (!options.length) break;

    const scores = options.map(o => {
      const a = appetite(bias, klass, o.tree, o.tal);
      // focus sharpens the choice; the floor keeps a weak talent merely
      // unlikely rather than impossible, which is how people actually play
      return Math.pow(Math.max(a, 0.01), 1 + bias.focus * 1.5);
    });

    const chosen = options[rng.weighted(scores)];
    st[chosen.tree.id][chosen.tal.id]++;
    route.push(rules.routeStep(chosen.tree, chosen.tal));
  }
  return route;
}

/** Human-readable spec line, e.g. "Enhancement 31 / Elemental 20". */
function describe(trees, st) {
  return trees
    .map(t => ({ name: t.name, n: rules.treePoints(t, st) }))
    .filter(x => x.n > 0)
    .sort((a, b) => b.n - a.n)
    .map(x => `${x.name} ${x.n}`)
    .join(" / ") || "no points";
}

module.exports = { randomBias, appetite, generate, describe };
