"use strict";
/**
 * Talent tree rules, lifted from src/template.html so the sim spends points by
 * exactly the same law the calculator does. A route this file produces is a
 * legal build: you can paste it into the page and it will load.
 *
 * If you change a rule here, change it there too - or better, notice that they
 * have drifted, because test.js checks a generated route against the page's own
 * validity check.
 */

const fs = require("fs");
const path = require("path");

const FIRST_POINT_LEVEL = 10;
const row = pos => pos.charCodeAt(0) - 97;   // "a2" -> 0

/* ---------------- data ---------------- */

const editionCache = new Map();

function edition(id) {
  if (!editionCache.has(id)) {
    const file = path.join(__dirname, "..", "src", "editions", id + ".json");
    editionCache.set(id, JSON.parse(fs.readFileSync(file, "utf8")));
  }
  return editionCache.get(id);
}

function classData(editionId, klass) {
  const ed = edition(editionId);
  const c = ed.classes[klass];
  if (!c) throw new Error(`no class ${klass} in edition ${editionId}`);
  return { edition: ed, trees: c.trees };
}

/* ---------------- legality ---------------- */

const emptyState = trees => {
  const st = {};
  for (const tree of trees) {
    st[tree.id] = {};
    for (const tal of tree.talents) st[tree.id][tal.id] = 0;
  }
  return st;
};

const treePoints = (tree, st) =>
  tree.talents.reduce((n, t) => n + st[tree.id][t.id], 0);

const totalPoints = (trees, st) =>
  trees.reduce((n, t) => n + treePoints(t, st), 0);

// Only points in tiers strictly above this one open a tier gate. Points spent
// beside or below a talent do not count towards its requirement.
function pointsBelowTier(tree, tier, st) {
  return tree.talents.reduce(
    (n, t) => n + (row(t.pos) < tier ? st[tree.id][t.id] : 0), 0);
}

function prereqMet(tree, tal, st) {
  if (!tal.prereq) return true;
  const p = tree.talents.find(t => t.id === tal.prereq);
  return !p || st[tree.id][p.id] >= p.maxRank;
}

const tierMet = (tree, tal, st) =>
  pointsBelowTier(tree, row(tal.pos), st) >= tal.reqPoints;

function canLearn(tree, tal, st) {
  return st[tree.id][tal.id] < tal.maxRank
      && tierMet(tree, tal, st)
      && prereqMet(tree, tal, st);
}

/**
 * Every talent that could legally take a point right now, across all trees.
 * The sim picks from this, so it can never build something the game would
 * refuse - the awkward routes it produces are awkward, not illegal.
 */
function learnable(trees, st) {
  const out = [];
  for (const tree of trees) {
    for (const tal of tree.talents) {
      if (canLearn(tree, tal, st)) out.push({ tree, tal });
    }
  }
  return out;
}

/* ---------------- routes ---------------- */

/**
 * A route is the ordered list of points a bot intends to spend, one entry per
 * level from 10 up. Same shape as the page's spendOrder, so it round-trips.
 */
function routeStep(tree, tal) {
  return { tree: tree.id, talent: tal.id };
}

/**
 * Replays a route and returns the state after `steps` points, or throws if the
 * route is illegal. Used to show a bot's build as it looked at any level.
 */
function replay(trees, route, steps) {
  const st = emptyState(trees);
  const take = steps === undefined ? route.length : Math.min(steps, route.length);
  for (let i = 0; i < take; i++) {
    const step = route[i];
    const tree = trees.find(t => t.id === step.tree);
    if (!tree) throw new Error(`route step ${i}: no tree ${step.tree}`);
    const tal = tree.talents.find(t => t.id === step.talent);
    if (!tal) throw new Error(`route step ${i}: no talent ${step.talent}`);
    if (!canLearn(tree, tal, st)) {
      throw new Error(`route step ${i}: ${step.talent} is not learnable yet`);
    }
    st[tree.id][tal.id]++;
  }
  return st;
}

/** The level at which a route's Nth point gets spent. */
const levelForStep = n => FIRST_POINT_LEVEL + n;

module.exports = {
  FIRST_POINT_LEVEL, row,
  edition, classData,
  emptyState, treePoints, totalPoints,
  canLearn, learnable, prereqMet, tierMet,
  routeStep, replay, levelForStep,
};
