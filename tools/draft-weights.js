#!/usr/bin/env node
"use strict";
/**
 * A first pass at sim/weights/<class>.json, read off the talent tooltips.
 *
 *   node tools/draft-weights.js              every class that has none
 *   node tools/draft-weights.js Mage --force redraft one
 *
 * --force redrafts files this tool wrote. It will NOT touch a hand-written one
 * (a file with no _derived flag); that needs --clobber-handwritten.
 *
 * This is a DRAFT generator, and the files it writes say so. It matches the
 * rank text against a keyword table and scales by whatever percentage the
 * tooltip quotes, which gets the shape right - damage talents score power,
 * mana talents score sustain - and the detail wrong. A talent whose value is
 * situational, or whose text does not mention a number, is guessed flatly.
 *
 * Shaman was written by hand and is not regenerated; treat it as the reference
 * for what a tuned file looks like.
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const EDITION = JSON.parse(
  fs.readFileSync(path.join(ROOT, "src", "editions", "forever.json"), "utf8"));

/* ---------------- the keyword table ---------------- */
/*
 * Order matters only in that every rule that matches contributes. Weights are
 * per point of the quoted percentage; see scale() below.
 */
const RULES = [
  // --- power: things die faster ---
  [/increases?\s+(?:the\s+)?(?:\w+\s+){0,2}damage\s+(?:done|caused|dealt|you deal)/i, "power", 1.0],
  [/increases?\s+(?:the\s+)?damage\s+of\s+your/i, "power", 1.0],
  [/increases?\s+your\s+(?:\w+\s+){0,2}(?:weapon\s+)?damage/i, "power", 0.9],
  [/(?:critical\s+strike|critical)\s+(?:chance|rating)|chance\s+to\s+(?:get\s+a\s+)?crit/i, "power", 2.2],
  [/increases?\s+your\s+\w*\s*critical/i, "power", 2.0],
  [/critical\s+strike\s+damage\s+bonus|critical\s+damage/i, "power", 0.5],
  [/attack\s+power/i, "power", 0.8],
  [/attack\s+speed|haste/i, "power", 1.4],
  [/(?:cast|casting)\s+time|global\s+cooldown/i, "power", 1.2],
  [/spell\s+(?:power|damage)/i, "power", 1.0],
  [/chance\s+to\s+hit|chance\s+to\s+miss/i, "power", 1.6],
  [/reduces?\s+the\s+cooldown/i, "power", 0.45],
  [/(?:deals?|inflicts?|causes?)\s+.*damage|instantly\s+(?:strike|attack|shoot|deal)/i, "power", 0.0, 0.05],
  [/chance\s+to\s+(?:activate|trigger|proc|reset)/i, "power", 0.9, 0.035],
  [/(?:bleed|burn|poison|dot|damage\s+over\s+time)/i, "power", 0.5],
  [/increases?\s+the\s+duration\s+of\s+your/i, "power", 0.35],
  [/specialization/i, "power", 0.6],

  // --- sustain: less time stopped ---
  // rage, energy and focus are the melee classes' mana: the same talent that
  // would read "costs less mana" on a caster reads "costs less rage" here
  [/reduces?\s+the\s+(?:\w+\s+)?cost/i, "sustain", 0.9, 0.03],
  [/(?:rage|energy|focus|mana)\s+(?:cost|generated|generation)/i, "sustain", 0.9, 0.035],
  [/generates?\s+\d+\s+(?:rage|energy|focus)|increases?\s+your\s+maximum\s+(?:rage|energy|focus)/i, "sustain", 0.0, 0.04],
  [/(?:mana|health)\s+regenerat|regenerates?\s+\d/i, "sustain", 1.0, 0.04],
  [/increases?\s+your\s+(?:intellect|spirit)/i, "sustain", 0.8],
  [/(?:restores?|replenish\w*)\s+.*(?:mana|health)/i, "sustain", 0.0, 0.045],
  [/(?:amount\s+healed|effectiveness\s+of\s+your\s+healing|healing\s+done)/i, "sustain", 0.7],
  [/heals?\s+(?:you|the\s+caster|a\s+friendly|your)/i, "sustain", 0.0, 0.04],
  [/clearcasting|no\s+mana\s+cost|costs?\s+no/i, "sustain", 0.0, 0.05],
  [/retain\s+up\s+to|rage\s+loss/i, "sustain", 0.0, 0.03],
  [/life\s*(?:steal|tap)|drain\s+life|siphon/i, "sustain", 0.0, 0.045],

  // --- defense: fights go wrong less often ---
  [/(?:reduces?|decreases?)\s+(?:all\s+)?(?:the\s+)?damage\s+(?:taken|you\s+take)/i, "defense", 1.4],
  [/increases?\s+your\s+armor|armor\s+value/i, "defense", 0.5],
  [/(?:dodge|parry|block)\s+chance|chance\s+to\s+(?:dodge|parry|block)/i, "defense", 1.4],
  [/increases?\s+your\s+(?:total\s+)?(?:stamina|maximum\s+health|health)/i, "defense", 1.0],
  [/(?:reduces?|decreases?)\s+(?:all\s+)?(?:the\s+)?threat/i, "defense", 0.4],
  [/(?:stun|immobiliz|incapacitat|disorient|root|snare|silenc|fear)/i, "defense", 0.0, 0.03],
  [/(?:movement\s+speed|attack\s+speed)\s+of\s+(?:your\s+)?(?:target|enemies)/i, "defense", 0.5],
  [/avoid\s+interrupt|pushback|resist/i, "defense", 0.4, 0.02],
  [/absorb|shield/i, "defense", 0.6, 0.025],
  [/reduces?\s+the\s+cooldown\s+of\s+your\s+(?:reincarnation|shield|block|defensive)/i, "defense", 0.4],

  // --- aoe: pulling more than one ---
  [/all\s+(?:nearby\s+)?(?:targets|enemies|opponents)|nearby\s+(?:enemies|opponents)|area\s+of\s+effect|in\s+a\s+cone/i, "aoe", 0.0, 0.05],
  [/(?:fire\s+nova|blizzard|consecration|whirlwind|cleave|swipe|volley|explosion|hurricane|rain\s+of\s+fire|multi-?shot|thunder\s+clap)/i, "aoe", 0.0, 0.05],
  [/additional\s+(?:nearby\s+)?(?:target|opponent|enemy)|chain\s+(?:lightning|heal)/i, "aoe", 0.0, 0.04],
  [/increases?\s+the\s+radius/i, "aoe", 0.5, 0.02],
];

const CAP = { power: 0.075, sustain: 0.085, defense: 0.06, aoe: 0.05 };

/** Biggest percentage quoted in the text, or null. */
function biggestPercent(text) {
  const nums = [...String(text).matchAll(/(\d+(?:\.\d+)?)\s*%/g)].map(m => Number(m[1]));
  return nums.length ? Math.max(...nums) : null;
}

function weightsFor(tal) {
  const top = tal.ranks[tal.ranks.length - 1] || "";
  const clean = top.replace(/<[^>]*>/g, " ");
  const pct = biggestPercent(clean);
  const out = {};

  for (const [re, stat, perPercent, flat] of RULES) {
    if (!re.test(clean)) continue;
    let v;
    if (pct != null && perPercent) {
      // a talent quoting "+10%" over 5 ranks is worth 2% a rank
      v = (pct / 100) * perPercent / tal.maxRank;
    } else if (flat) {
      v = flat / tal.maxRank;
    } else {
      continue;
    }
    out[stat] = Math.min(CAP[stat], (out[stat] || 0) + v);
  }

  // A talent nothing matched still costs a point, and a point spent on nothing
  // should look like nothing - leave it out rather than inventing a value.
  for (const k of Object.keys(out)) if (out[k] < 0.002) delete out[k];
  return out;
}

/* ---------------- normalise against the hand-written file ---------------- */
/*
 * Without this the generator decides the race. A drafted class came out on a
 * hotter scale than the hand-tuned Shaman - power totals roughly twice as high
 * - so drafted classes simply out-levelled the one real file, and "which class
 * is winning" measured my keyword table rather than the talents.
 *
 * So every class is scaled to carry the same total pool of each stat as the
 * reference. What is left to differ is the shape: how that pool is spread
 * across the trees, and therefore what a bot picking greedily ends up with.
 */
const REFERENCE = "Shaman";

function poolOf(classTalents, weights) {
  const pool = { power: 0, sustain: 0, defense: 0, aoe: 0 };
  for (const tree of classTalents.trees) {
    for (const tal of tree.talents) {
      const w = weights[tal.id];
      if (!w) continue;
      for (const k of Object.keys(pool)) if (w[k]) pool[k] += w[k] * tal.maxRank;
    }
  }
  return pool;
}

function referencePool() {
  const file = path.join(ROOT, "sim", "weights",
    REFERENCE.toLowerCase().replace(/\s+/g, "-") + ".json");
  const ref = JSON.parse(fs.readFileSync(file, "utf8"));
  return poolOf(EDITION.classes[REFERENCE], ref.talents);
}

function normalise(klass, talents) {
  if (klass === REFERENCE) return talents;
  const want = referencePool();
  const have = poolOf(EDITION.classes[klass], talents);
  const factor = {};
  for (const k of Object.keys(want)) {
    factor[k] = have[k] > 0 ? want[k] / have[k] : 1;
  }
  const out = {};
  for (const [id, w] of Object.entries(talents)) {
    const scaled = {};
    for (const [k, v] of Object.entries(w)) {
      const n = Math.round(v * factor[k] * 1e5) / 1e5;
      if (n >= 0.002) scaled[k] = n;
    }
    out[id] = scaled;
  }
  return out;
}

/* ---------------- write ---------------- */

const only = process.argv.slice(2).filter(a => !a.startsWith("--"));
const force = process.argv.includes("--force");
const clobber = process.argv.includes("--clobber-handwritten");

let wrote = 0, skipped = 0;
for (const [klass, data] of Object.entries(EDITION.classes)) {
  if (only.length && !only.includes(klass)) continue;

  const file = path.join(ROOT, "sim", "weights",
    klass.toLowerCase().replace(/\s+/g, "-") + ".json");

  // A hand-written file is work this tool cannot reproduce, so --force does not
  // reach it. Clobbering one needs saying so out loud.
  if (fs.existsSync(file)) {
    const existing = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!existing._derived && !clobber) {
      skipped++;
      console.log(`  ${klass.padEnd(14)} kept - hand-written (--clobber-handwritten to overwrite)`);
      continue;
    }
    if (existing._derived && !force) {
      skipped++;
      console.log(`  ${klass.padEnd(14)} kept - already drafted (--force to redraft)`);
      continue;
    }
  }

  const talents = {};
  let blank = 0;
  for (const tree of data.trees) {
    for (const tal of tree.talents) {
      const w = weightsFor(tal);
      talents[tal.id] = w;
      if (!Object.keys(w).length) blank++;
    }
  }

  const scaled = normalise(klass, talents);

  const doc = {
    _comment: [
      "DRAFT - generated by tools/draft-weights.js from the talent tooltips.",
      "",
      "The shape is right and the detail is not: a damage talent scores power, a",
      "mana talent scores sustain, and anything situational is a flat guess. Tune",
      "the ones that matter and the races will change; sim/weights/shaman.json is",
      "hand-written and shows what a tuned file looks like.",
      "",
      "Delete the _derived flag below once a file has been gone over by hand, and",
      "the drafter will stop overwriting it.",
      "",
      "Every class is scaled to carry the same total pool of each stat as the",
      "hand-written Shaman file, so no class wins just because its weights came",
      "out hotter. What still differs is the shape - how that pool is spread",
      "across the three trees.",
    ],
    _derived: true,
    class: klass,
    edition: EDITION.id,
    _normalisedAgainst: klass === "Shaman" ? null : "Shaman",
    talents: scaled,
  };

  fs.writeFileSync(file, JSON.stringify(doc, null, 2) + "\n");
  wrote++;
  const total = Object.keys(talents).length;
  console.log(`  ${klass.padEnd(14)} ${total} talents, ${blank} scored nothing -> ${path.relative(ROOT, file)}`);
}

console.log(`\n${wrote} written, ${skipped} left alone`);
