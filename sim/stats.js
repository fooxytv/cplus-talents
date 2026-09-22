"use strict";
/**
 * Turns a build into the four numbers the race actually runs on.
 *
 * This is the whole point of the project: a bot is not "fast" because it was
 * given a good seed, it is fast because of what it put its points into. Two
 * Shamans with the same luck and different routes finish days apart.
 */

const fs = require("fs");
const path = require("path");
const rules = require("./rules");

const STATS = ["power", "sustain", "defense", "aoe"];

const weightCache = new Map();

function weights(klass) {
  const key = klass.toLowerCase().replace(/\s+/g, "-");
  if (!weightCache.has(key)) {
    const file = path.join(__dirname, "weights", key + ".json");
    if (!fs.existsSync(file)) {
      throw new Error(`no levelling weights for ${klass} - add sim/weights/${key}.json`);
    }
    weightCache.set(key, JSON.parse(fs.readFileSync(file, "utf8")));
  }
  return weightCache.get(key);
}

const zero = () => ({ power: 0, sustain: 0, defense: 0, aoe: 0 });

/** Stats contributed by a talent state (the object of tree -> talent -> rank). */
function statsFor(klass, trees, st) {
  const w = weights(klass).talents;
  const out = zero();
  for (const tree of trees) {
    for (const tal of tree.talents) {
      const rank = st[tree.id][tal.id];
      if (!rank) continue;
      const contrib = w[tal.id] || w[tal.name];
      if (!contrib) continue;               // untagged talents are simply worth nothing
      for (const s of STATS) {
        if (contrib[s]) out[s] += contrib[s] * rank;
      }
    }
  }
  return out;
}

/** Stats after the first `points` steps of a route. */
function statsAtStep(klass, trees, route, points) {
  return statsFor(klass, trees, rules.replay(trees, route, points));
}

/**
 * Every talent in a class that carries no weight. Not an error - plenty of
 * talents genuinely do nothing for a solo leveller - but worth being able to
 * list, so "we forgot to tag it" and "it is deliberately worthless" stay
 * distinguishable.
 */
function untagged(klass, trees) {
  const w = weights(klass).talents;
  const out = [];
  for (const tree of trees) {
    for (const tal of tree.talents) {
      if (!w[tal.id] && !w[tal.name]) out.push(tree.id + "/" + tal.name);
    }
  }
  return out;
}

module.exports = { STATS, weights, zero, statsFor, statsAtStep, untagged };
