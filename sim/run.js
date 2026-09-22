#!/usr/bin/env node
"use strict";
/**
 * Run a race headless and print the result.
 *
 *   node sim/run.js                          30 Shamans, normal rules
 *   node sim/run.js --bots 40 --hardcore
 *   node sim/run.js --seed 7 --db data/sim.db
 *
 * This is how the model gets tuned: run it, look at whether the finishing order
 * tracks the builds, and change the dials in engine.js until it does without
 * becoming a procession.
 */

const path = require("path");
const db_ = require("./db");
const race_ = require("./race");
const rules = require("./rules");
const stats = require("./stats");
const routes = require("./routes");
const { TUNING } = require("./engine");

const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf("--" + name);
  if (i < 0) return dflt;
  const next = argv[i + 1];
  return next && !next.startsWith("--") ? next : true;
};

const bots = Number(flag("bots", 30));
const seed = Number(flag("seed", 1)) >>> 0;
const hardcore = !!flag("hardcore", false);
const klass = String(flag("class", "Shaman"));
const editionId = String(flag("edition", "forever"));
const dbPath = String(flag("db", path.join(__dirname, "..", "data", "sim.db")));
const maxDays = Number(flag("days", 400));

const db = db_.open(dbPath);
const q = db_.statements(db);

const id = "run-" + seed + "-" + Date.now().toString(36);
console.log(`race ${id}: ${bots} ${klass}s, ${editionId}, ${hardcore ? "HARDCORE" : "normal"}, seed ${seed}\n`);

const { race, bots: roster } = race_.createRace(db, q, {
  id, editionId, klass, count: bots, seed, hardcore,
  name: `${bots} ${klass}s`,
});

// run in day-long chunks so it is interruptible and so progress is visible
let done = false, days = 0;
while (!done && days < maxDays) {
  ({ done } = race_.advance(db, q, race, roster, 24 * 60));
  days++;
}

/* ---------------- results ---------------- */

const hhmm = m => `${Math.floor(m / 60)}h${String(Math.round(m % 60)).padStart(2, "0")}`;
const board = q.board.all(id);
const { trees } = rules.classData(editionId, klass);

console.log(`after ${days} days of race time\n`);
console.log("  #  name         lvl  spec                          played   deaths  power sust  def");
console.log("  " + "-".repeat(88));

board.forEach((b, i) => {
  const bot = roster.find(x => x.id === b.bot_id);
  const s = stats.statsAtStep(klass, trees, bot.route, b.step);
  const flagStr = b.finished_at !== null ? "FINISHED" : (b.alive ? "" : "DEAD");
  console.log(
    `  ${String(i + 1).padStart(2)}  ${b.name.padEnd(12)} ${String(b.level).padStart(3)}` +
    `  ${b.spec.padEnd(28).slice(0, 28)}  ${hhmm(b.played_minutes).padStart(7)}` +
    `   ${String(b.deaths).padStart(4)}   ` +
    `${s.power.toFixed(2)} ${s.sustain.toFixed(2)} ${s.defense.toFixed(2)}  ${flagStr}`
  );
});

/* did the build decide it? */
const finishers = board.filter(b => b.finished_at !== null);
if (finishers.length >= 3) {
  const withStats = finishers.map(b => {
    const bot = roster.find(x => x.id === b.bot_id);
    const s = stats.statsAtStep(klass, trees, bot.route, b.step);
    // the build's own predicted speed, straight out of the engine's formula -
    // the honest way to ask "did the build decide it", rather than a crude sum
    const rate = (1 + s.power * TUNING.powerK)
               * (1 + s.aoe * TUNING.aoeK)
               * (1 - TUNING.baseDowntime / (1 + s.sustain * TUNING.sustainK));
    return { ...b, ...s, buildRate: rate };
  });
  const corr = (xs, ys) => {
    const n = xs.length;
    const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
    let num = 0, dx = 0, dy = 0;
    for (let i = 0; i < n; i++) {
      num += (xs[i] - mx) * (ys[i] - my);
      dx += (xs[i] - mx) ** 2; dy += (ys[i] - my) ** 2;
    }
    return dx && dy ? num / Math.sqrt(dx * dy) : 0;
  };
  const played = withStats.map(b => b.played_minutes);
  console.log("\n  how much did the build matter? (correlation with hours played, -1 is ideal)");
  for (const key of ["power", "sustain", "defense", "buildRate"]) {
    console.log(`    ${key.padEnd(11)} ${corr(withStats.map(b => b[key]), played).toFixed(3)}`);
  }
  const fastest = withStats.reduce((a, b) => a.played_minutes <= b.played_minutes ? a : b);
  const slowest = withStats.reduce((a, b) => a.played_minutes >= b.played_minutes ? a : b);
  console.log(`\n  fastest ${fastest.name} ${hhmm(fastest.played_minutes)} (${fastest.spec})`);
  console.log(`  slowest ${slowest.name} ${hhmm(slowest.played_minutes)} (${slowest.spec})`);
  console.log(`  spread  ${hhmm(slowest.played_minutes - fastest.played_minutes)}`);
}

console.log(`\n  ${finishers.length}/${board.length} reached 60`);
console.log(`  stored in ${dbPath} as ${id}`);
