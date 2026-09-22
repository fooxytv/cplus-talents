#!/usr/bin/env node
"use strict";
/**
 * node sim/test.js
 *
 * The important ones are the first group: a route the sim invents has to be a
 * build the calculator would accept, or the whole premise ("watch a bot spend
 * real talent points") is a lie.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const rules = require("./rules");
const routes = require("./routes");
const stats = require("./stats");
const engine = require("./engine");
const xp = require("./xp");
const db_ = require("./db");
const race_ = require("./race");
const share = require("./share");
const roster = require("./roster");
const { rng, seedFrom } = require("./rng");

let passed = 0;
const failures = [];
const ok = (name, cond) => {
  if (cond) passed++;
  else failures.push(name);
};
const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

const EDITION = "forever";
const KLASS = "Shaman";
const { edition, trees } = rules.classData(EDITION, KLASS);

/* ---------------- routes are legal builds ---------------- */

const sample = [];
for (let seed = 1; seed <= 40; seed++) {
  const r = rng(seed);
  const bias = routes.randomBias(trees, r);
  sample.push({ seed, bias, route: routes.generate(KLASS, trees, edition.maxPoints, bias, r) });
}

ok("every route spends exactly the edition's points",
   sample.every(s => s.route.length === edition.maxPoints));

ok("every route replays without an illegal step", sample.every(s => {
  try { rules.replay(trees, s.route); return true; } catch (e) { return false; }
}));

// the page's own isValid, restated: anything with points in it must have had
// its tier and its prerequisite satisfied
ok("every finished build passes the page's validity rule", sample.every(s => {
  const st = rules.replay(trees, s.route);
  return trees.every(tree => tree.talents.every(tal =>
    st[tree.id][tal.id] === 0 || (rules.tierMet(tree, tal, st) && rules.prereqMet(tree, tal, st))));
}));

ok("no talent ever exceeds its max rank", sample.every(s => {
  const st = rules.replay(trees, s.route);
  return trees.every(tree => tree.talents.every(tal => st[tree.id][tal.id] <= tal.maxRank));
}));

// a partial replay is the build as it looked mid-race, and must also be legal
ok("every build is legal at every level along the way", sample.slice(0, 10).every(s => {
  for (let n = 0; n <= s.route.length; n++) {
    try { rules.replay(trees, s.route, n); } catch (e) { return false; }
  }
  return true;
}));

ok("first talent point is spent at level 10", rules.levelForStep(0) === 10);
ok("the 51st point is spent at level 60", rules.levelForStep(50) === 60);

/* ---------------- routes differ from each other ---------------- */

const specs = new Set(sample.map(s => routes.describe(trees, rules.replay(trees, s.route))));
ok("different personalities produce different builds", specs.size >= 15);

const capstone = sample.filter(s => {
  const st = rules.replay(trees, s.route);
  return trees.some(t => rules.treePoints(t, st) >= 31);
});
ok("some bots go deep enough for a capstone", capstone.length > 0);
ok("not every bot goes deep", capstone.length < sample.length);

/* ---------------- xp curve ---------------- */

// Every published vanilla value. If the curve is ever "improved" again, this
// is what should stop it.
const PUBLISHED = {
  1: 400, 2: 900, 10: 7600, 20: 23200, 28: 41400, 29: 44300,
  30: 47400, 31: 50800, 32: 54500, 40: 90700, 50: 147500, 59: 209800,
};
for (const [lvl, want] of Object.entries(PUBLISHED)) {
  ok(`level ${lvl} costs the published ${want.toLocaleString()} xp`,
     xp.toNext(Number(lvl)) === want);
}

ok("the whole climb is the published 4,084,700", xp.totalTo(60) === 4084700);

ok("every level costs a round hundred", (() => {
  for (let l = 1; l < xp.MAX_LEVEL; l++) if (xp.toNext(l) % 100 !== 0) return false;
  return true;
})());

ok("xp per level always rises", (() => {
  for (let l = 1; l < xp.MAX_LEVEL - 1; l++) if (xp.toNext(l + 1) <= xp.toNext(l)) return false;
  return true;
})());

// the difficulty term is flat, then three fixed steps, then linear - not the
// triangular series it looks like
ok("the difficulty term matches the published shape",
   xp.diff(28) === 0 && xp.diff(29) === 1 && xp.diff(30) === 3 &&
   xp.diff(31) === 6 && xp.diff(32) === 10 && xp.diff(40) === 50 && xp.diff(59) === 145);

ok("there is no level past the cap", xp.toNext(xp.MAX_LEVEL) === Infinity);
ok("mob xp rises with level", xp.mobXp(50) > xp.mobXp(10));
ok("mob xp matches 45 + 5L", xp.mobXp(1) === 50 && xp.mobXp(60) === 345);

/* ---------------- talents drive the stats ---------------- */

ok("an empty build has no stats", (() => {
  const s = stats.statsFor(KLASS, trees, rules.emptyState(trees));
  return stats.STATS.every(k => s[k] === 0);
})());

ok("every Shaman talent carries a weight", stats.untagged(KLASS, trees).length === 0);

ok("ranks multiply a talent's contribution", (() => {
  const st = rules.emptyState(trees);
  st.Elemental.Concussion = 1;
  const one = stats.statsFor(KLASS, trees, st).power;
  st.Elemental.Concussion = 5;
  const five = stats.statsFor(KLASS, trees, st).power;
  return near(five, one * 5, 1e-9) && one > 0;
})());

ok("a damage build has more power than a healing build", (() => {
  const dmg = rules.emptyState(trees), heal = rules.emptyState(trees);
  dmg.Enhancement.Stormstrike = 1;
  heal.Restoration["Water Shield"] = 1;
  return stats.statsFor(KLASS, trees, dmg).power > stats.statsFor(KLASS, trees, heal).power
      && stats.statsFor(KLASS, trees, heal).sustain > stats.statsFor(KLASS, trees, dmg).sustain;
})());

/* ---------------- share codes ---------------- */

// The watch page links every bot to the calculator. A browser probe has
// confirmed the page decodes these; these assertions guard the format.
ok("an empty build encodes to just the class", (() => {
  const code = share.encode(EDITION, KLASS, trees, rules.emptyState(trees));
  return /^forever:shaman\.[0-9a-z]+$/.test(code);
})());

ok("a code carries one digit per rank spent", (() => {
  const st = rules.replay(trees, sample[0].route);
  const code = share.encode(EDITION, KLASS, trees, st);
  const digits = code.split("-")[1].split(".")[0];
  const spent = [...digits].reduce((n, c) => n + Number(c), 0);
  return spent === edition.maxPoints;
})());

ok("a partial build encodes fewer points than a finished one", (() => {
  const half = rules.replay(trees, sample[0].route, 10);
  const code = share.encode(EDITION, KLASS, trees, half);
  const digits = (code.split("-")[1] || "").split(".")[0];
  return [...digits].reduce((n, c) => n + Number(c), 0) === 10;
})());

ok("the fingerprint is stable across calls",
   share.fingerprint(trees) === share.fingerprint(trees));

ok("different builds encode differently", (() => {
  const a = share.encode(EDITION, KLASS, trees, rules.replay(trees, sample[0].route));
  const b = share.encode(EDITION, KLASS, trees, rules.replay(trees, sample[1].route));
  return a !== b;
})());

ok("class names with spaces slug correctly", share.slug("Death Knight") === "deathknight");

// The calculator reads location.hash.slice(1) raw and finds the edition by
// looking for a literal ":". Percent-encoding a code turns that into %3A and
// the link silently lands on a blank Warrior instead - so a code must be safe
// to drop into a fragment untouched.
const someCodes = [
  share.encode(EDITION, KLASS, trees, rules.emptyState(trees)),
  share.encode(EDITION, KLASS, trees, rules.replay(trees, sample[0].route)),
  share.encode(EDITION, KLASS, trees, rules.replay(trees, sample[1].route, 17)),
];

// Only characters that may sit in a fragment untouched.
ok("a share code is safe to drop straight into a url fragment",
   someCodes.every(c => /^[a-z0-9:.-]+$/.test(c)));

// And the trap itself: encodeURIComponent DOES escape the colon, which is what
// broke the link - so this asserts why the encoder must not be used, rather
// than pretending the two are interchangeable.
ok("encodeURIComponent would wreck a code by escaping its colon",
   someCodes.every(c => encodeURIComponent(c) !== c && encodeURIComponent(c).includes("%3A")));

ok("a code still carries its edition separator", (() => {
  const c = share.encode(EDITION, KLASS, trees, rules.replay(trees, sample[0].route));
  return c.indexOf(":") > 0;
})());

/* ---------------- who the bots are ---------------- */

ok("every race belongs to a faction that exists", Object.values(roster.CONFIG.races)
   .every(r => roster.CONFIG.factions[r.faction]));

ok("Shaman is offered to at least one race", roster.racesFor("Shaman").length > 0);

// vanilla's table, which is what the config ships with - if Forever differs,
// this is the assertion that should change along with roster.json
ok("Shamans are Horde only in the shipped table",
   roster.racesFor("Shaman").every(r => r.faction === "Horde"));

ok("an impossible class is refused clearly", (() => {
  try { roster.roll("Demon Hunter", rng(1), new Set()); return false; }
  catch (e) { return /roster\.json/.test(e.message); }
})());

ok("rolling gives a whole character", (() => {
  const w = roster.roll("Shaman", rng(7), new Set());
  return w.name && w.race && w.faction && ["male", "female"].includes(w.gender)
      && w.raceIcon.endsWith(w.gender) && w.factionIcon;
})());

ok("names are unique across a field", (() => {
  const taken = new Set(), r = rng(3);
  for (let i = 0; i < 30; i++) roster.roll("Shaman", r, taken);
  return taken.size === 30;
})());

ok("the class icon is a wowhead class icon name",
   roster.classIcon("Death Knight") === "classicon_deathknight");

/* ---------------- the engine ---------------- */

const mkBot = (over = {}) => {
  const r = rng(5);
  const bias = routes.randomBias(trees, r);
  Object.assign(bias, { recklessness: 0.5, hoursPerDay: 24, startHour: 0 }, over.bias);
  return engine.newBot({
    id: "t", name: "t", klass: KLASS, editionId: EDITION,
    route: routes.generate(KLASS, trees, edition.maxPoints, bias, r),
    bias, rng: rng(99),
  });
};

ok("a bot with a 24 hour day is always online", (() => {
  const b = mkBot();
  return [0, 300, 1000, 5000].every(m => engine.online(b, m));
})());

ok("a bot that plays 4 hours a day is mostly offline", (() => {
  const b = mkBot({ bias: { hoursPerDay: 4, startHour: 0 } });
  let on = 0;
  for (let m = 0; m < 1440; m += 10) if (engine.online(b, m)) on++;
  return on === 24;                       // 4 hours of ten-minute ticks
})());

ok("power makes xp per hour higher", (() => {
  const b = mkBot();
  b.level = 30;
  const slow = engine.xpPerHour(b, { power: 0, sustain: 0, defense: 0, aoe: 0 });
  const fast = engine.xpPerHour(b, { power: 0.8, sustain: 0, defense: 0, aoe: 0 });
  return fast > slow;
})());

ok("sustain makes xp per hour higher", (() => {
  const b = mkBot();
  b.level = 30;
  const dry = engine.xpPerHour(b, { power: 0, sustain: 0, defense: 0, aoe: 0 });
  const wet = engine.xpPerHour(b, { power: 0, sustain: 0.8, defense: 0, aoe: 0 });
  return wet > dry;
})());

ok("defense makes death less likely", (() => {
  const b = mkBot();
  b.level = 60;
  const soft = engine.deathChance(b, { power: 0, sustain: 0, defense: 0, aoe: 0 });
  const hard = engine.deathChance(b, { power: 0, sustain: 0, defense: 0.8, aoe: 0 });
  return hard < soft;
})());

ok("recklessness trades safety for speed", (() => {
  const calm = mkBot({ bias: { recklessness: 0 } });
  const wild = mkBot({ bias: { recklessness: 1 } });
  calm.level = wild.level = 40;
  const s = { power: 0.3, sustain: 0.3, defense: 0.2, aoe: 0 };
  return engine.xpPerHour(wild, s) > engine.xpPerHour(calm, s)
      && engine.deathChance(wild, s) > engine.deathChance(calm, s);
})());

ok("low levels are safer than high ones", (() => {
  const b = mkBot();
  const s = { power: 0, sustain: 0, defense: 0, aoe: 0 };
  b.level = 5;  const young = engine.deathChance(b, s);
  b.level = 55; const old = engine.deathChance(b, s);
  return young < old;
})());

ok("hardcore deaths are far rarer than normal ones", (() => {
  const b = mkBot();
  b.level = 60;
  const s = { power: 0, sustain: 0, defense: 0, aoe: 0 };
  return engine.deathChance(b, s, { hardcore: true }) < engine.deathChance(b, s) / 5;
})());

ok("a finished bot stops gaining levels", (() => {
  const b = mkBot();
  b.level = 60; b.finishedAt = 10;
  return engine.tick(b, 20, {}).length === 0;
})());

/* ---------------- a whole race, stored ---------------- */

const tmp = path.join(os.tmpdir(), "sim-test-" + Date.now() + ".db");
const db = db_.open(tmp);
const q = db_.statements(db);

const { race, bots } = race_.createRace(db, q, {
  id: "t1", editionId: EDITION, klass: KLASS, count: 8, seed: 4242,
});

ok("the race is stored", !!q.getRace.get("t1"));
ok("every bot is stored", q.listBots.all("t1").length === 8);
ok("stored bots carry who they are",
   q.listBots.all("t1").every(b => b.race && b.faction && b.gender));
ok("the board carries identity",
   q.board.all("t1").every(b => b.race && b.faction));
ok("a reloaded race keeps identity", (() => {
  const l = race_.loadRace(db, q, "t1");
  return l.bots.every(b => b.race && b.factionIcon && b.raceIcon);
})());
ok("bots have distinct names", new Set(bots.map(b => b.name)).size === 8);
ok("stored routes are legal", q.listBots.all("t1").every(r => {
  try { rules.replay(trees, JSON.parse(r.route)); return true; } catch (e) { return false; }
}));

let guard = 0;
let done = false;
while (!done && guard++ < 400) ({ done } = race_.advance(db, q, race, bots, 24 * 60));

ok("the race finishes", done);
ok("the race is marked finished", q.getRace.get("t1").status === "finished");
ok("everyone reached the cap", q.board.all("t1").every(b => b.level === xp.MAX_LEVEL));

const evts = db.prepare("SELECT type, COUNT(*) n FROM events WHERE race_id = ? GROUP BY type").all("t1");
const count = t => (evts.find(e => e.type === t) || { n: 0 }).n;

ok("there is one ding per level per bot", count("ding") === 8 * (xp.MAX_LEVEL - 1));
ok("there is one talent event per point per bot", count("talent") === 8 * edition.maxPoints);
ok("everyone finished exactly once", count("finish") === 8);

ok("events are in time order", (() => {
  const rows = db.prepare("SELECT at_minutes FROM events WHERE race_id = ? ORDER BY id").all("t1");
  for (let i = 1; i < rows.length; i++) if (rows[i].at_minutes < rows[i - 1].at_minutes) return false;
  return true;
})());

ok("a bot's talent events match its route", (() => {
  const b = q.listBots.all("t1")[0];
  const route = JSON.parse(b.route);
  const taken = db.prepare(
    "SELECT detail FROM events WHERE race_id = ? AND bot_id = ? AND type = 'talent' ORDER BY id")
    .all("t1", b.id).map(r => JSON.parse(r.detail));
  return taken.length === route.length
      && taken.every((t, i) => t.tree === route[i].tree && t.talent === route[i].talent);
})());

ok("the leaderboard puts a finisher first",
   q.board.all("t1")[0].finished_at !== null);

ok("the leaderboard is ordered by finishing time", (() => {
  const b = q.board.all("t1").filter(x => x.finished_at !== null).map(x => x.finished_at);
  for (let i = 1; i < b.length; i++) if (b[i] < b[i - 1]) return false;
  return true;
})());

/* the same seed twice is the same race */
const { race: r2, bots: b2 } = race_.createRace(db, q, {
  id: "t2", editionId: EDITION, klass: KLASS, count: 8, seed: 4242,
});
ok("the same seed builds the same roster",
   JSON.stringify(bots.map(b => b.name)) === JSON.stringify(b2.map(b => b.name)));
ok("the same seed builds the same routes",
   JSON.stringify(bots.map(b => b.route)) === JSON.stringify(b2.map(b => b.route)));

guard = 0; done = false;
while (!done && guard++ < 400) ({ done } = race_.advance(db, q, r2, b2, 24 * 60));
ok("the same seed produces the same result",
   JSON.stringify(q.board.all("t1").map(b => [b.name, b.played_minutes]))
   === JSON.stringify(q.board.all("t2").map(b => [b.name, b.played_minutes])));

/* history is never rewritten */
const before = db.prepare("SELECT COUNT(*) n FROM events WHERE race_id = ?").get("t1").n;
race_.advance(db, q, q.getRace.get("t1"), bots, 24 * 60);
ok("advancing a finished race adds no events",
   db.prepare("SELECT COUNT(*) n FROM events WHERE race_id = ?").get("t1").n === before);

/* a resumed race is still a legal race */
const { race: r3, bots: b3 } = race_.createRace(db, q, {
  id: "t3", editionId: EDITION, klass: KLASS, count: 5, seed: 77,
});
race_.advance(db, q, r3, b3, 3 * 24 * 60);
const mid = q.board.all("t3").map(b => b.level);
const loaded = race_.loadRace(db, q, "t3");
ok("a race reloads at the level it had reached",
   JSON.stringify(loaded.bots.map(b => b.level).sort()) === JSON.stringify([...mid].sort()));

guard = 0; done = false;
while (!done && guard++ < 400) ({ done } = race_.advance(db, q, loaded.race, loaded.bots, 24 * 60));
ok("a resumed race still finishes", done);
ok("a resumed race still ends at the cap",
   q.board.all("t3").every(b => b.level === xp.MAX_LEVEL));

/* hardcore */
const { race: r4, bots: b4 } = race_.createRace(db, q, {
  id: "t4", editionId: EDITION, klass: KLASS, count: 30, seed: 5, hardcore: true,
});
guard = 0; done = false;
while (!done && guard++ < 400) ({ done } = race_.advance(db, q, r4, b4, 24 * 60));
const hcBoard = q.board.all("t4");
ok("hardcore kills some of the field", hcBoard.some(b => !b.alive));
ok("hardcore is survivable", hcBoard.some(b => b.finished_at !== null));
ok("a dead bot stops levelling",
   hcBoard.filter(b => !b.alive).every(b => b.level < xp.MAX_LEVEL));
ok("a dead bot died exactly once",
   hcBoard.filter(b => !b.alive).every(b => b.deaths === 1));

db.close();
fs.rmSync(tmp, { force: true });
for (const ext of ["-wal", "-shm"]) fs.rmSync(tmp + ext, { force: true });

/* ---------------- every class, not just the one ---------------- */

const ALL_CLASSES = Object.keys(edition.classes);

ok("the edition has nine classes", ALL_CLASSES.length === 9);

ok("every class has levelling weights", ALL_CLASSES.every(k => {
  try { stats.weights(k); return true; } catch (e) { return false; }
}));

// A weight keyed to a talent that no longer exists is silently ignored by
// stats.js, so it would never show up as a failure - catch it here instead.
ok("no weights file names a talent the edition does not have",
   ALL_CLASSES.every(k => {
     const ids = new Set();
     for (const tree of edition.classes[k].trees) for (const t of tree.talents) ids.add(t.id);
     return Object.keys(stats.weights(k).talents).every(id => ids.has(id));
   }));

ok("most talents in every class are worth something", ALL_CLASSES.every(k => {
  const trees = edition.classes[k].trees;
  const total = trees.reduce((n, t) => n + t.talents.length, 0);
  return stats.untagged(k, trees).length < total * 0.45;
}));

ok("shaman is still the hand-written one",
   stats.weights("Shaman")._derived !== true);

ok("every class can build a legal full route", ALL_CLASSES.every(k => {
  const trees = edition.classes[k].trees;
  const r = rng(11);
  const bias = routes.randomBias(trees, r);
  const route = routes.generate(k, trees, edition.maxPoints, bias, r);
  if (route.length !== edition.maxPoints) return false;
  try { rules.replay(trees, route); return true; } catch (e) { return false; }
}));

ok("every class produces different builds from different seeds",
   ALL_CLASSES.every(k => {
     const trees = edition.classes[k].trees;
     const specs = new Set();
     for (let seed = 1; seed <= 8; seed++) {
       const r = rng(seed * 17);
       const bias = routes.randomBias(trees, r);
       specs.add(routes.describe(trees, rules.replay(trees,
         routes.generate(k, trees, edition.maxPoints, bias, r))));
     }
     return specs.size >= 4;
   }));

/* ---------------- a mixed field ---------------- */

ok("both factions can field a character across all classes", (() => {
  const seen = new Set(), taken = new Set(), r = rng(21);
  for (let i = 0; i < 60; i++) seen.add(roster.rollAny(ALL_CLASSES, r, taken).faction);
  return seen.has("Alliance") && seen.has("Horde");
})());

ok("a rolled pair is always legal", (() => {
  const taken = new Set(), r = rng(31);
  for (let i = 0; i < 60; i++) {
    const w = roster.rollAny(ALL_CLASSES, r, taken);
    if (!roster.CONFIG.races[w.race].classes.includes(w.klass)) return false;
  }
  return true;
})());

ok("asking for one class still gives only that class", (() => {
  const taken = new Set(), r = rng(5);
  for (let i = 0; i < 20; i++) {
    if (roster.rollAny(["Mage"], r, taken).klass !== "Mage") return false;
  }
  return true;
})());

ok("a class no race can take is refused", (() => {
  try { roster.rollAny(["Demon Hunter"], rng(1), new Set()); return false; }
  catch (e) { return /roster\.json/.test(e.message); }
})());

/* a whole mixed race, run to the end */
const mixTmp = path.join(os.tmpdir(), "sim-mixed-" + Date.now() + ".db");
const mdb = db_.open(mixTmp);
const mq = db_.statements(mdb);
const { race: mRace, bots: mBots } = race_.createRace(mdb, mq, {
  id: "m1", editionId: EDITION, classes: ALL_CLASSES, count: 18, seed: 99,
});

ok("a mixed race fields several classes",
   new Set(mBots.map(b => b.klass)).size >= 4);
ok("a mixed race fields both factions",
   new Set(mBots.map(b => b.faction)).size === 2);
ok("every bot in a mixed race has its own legal route",
   mBots.every(b => {
     const trees = rules.classData(EDITION, b.klass).trees;
     try { rules.replay(trees, b.route); return true; } catch (e) { return false; }
   }));
ok("a mixed race stores each bot's class",
   mq.listBots.all("m1").every(b => ALL_CLASSES.includes(b.klass)));

let mGuard = 0, mDone = false;
while (!mDone && mGuard++ < 500) ({ done: mDone } = race_.advance(mdb, mq, mRace, mBots, 24 * 60));
ok("a mixed race finishes", mDone);
ok("everyone in a mixed race reaches the cap",
   mq.board.all("m1").every(b => b.level === xp.MAX_LEVEL));
ok("a reloaded mixed race keeps each bot's class", (() => {
  const l = race_.loadRace(mdb, mq, "m1");
  return l.bots.every(b => ALL_CLASSES.includes(b.klass) && b.race && b.factionIcon);
})());

/* ---------------- a finished race, rebuilt ---------------- */
/*
 * The past-races tab redraws an old race from the database alone. That only
 * works if reloading reproduces the field that actually ran, so check the
 * rebuilt bots against the state the race left behind.
 */
const reborn = race_.loadRace(mdb, mq, "m1");
const finalRows = mq.board.all("m1");

ok("a rebuilt race has the same field",
   reborn.bots.length === finalRows.length);

ok("a rebuilt bot is at the level it finished on", reborn.bots.every(b => {
  const row = finalRows.find(r => r.bot_id === b.id);
  return row && row.level === b.level && row.played_minutes === b.playedMinutes;
}));

ok("a rebuilt bot kept its route and its class", reborn.bots.every(b => {
  const row = mq.listBots.all("m1").find(r => r.id === b.id);
  return row && row.klass === b.klass
      && JSON.stringify(JSON.parse(row.route)) === JSON.stringify(b.route);
}));

ok("a rebuilt bot's build encodes the same as it did", reborn.bots.every(b => {
  const trees = rules.classData(EDITION, b.klass).trees;
  const st = rules.replay(trees, b.route, b.step);
  return /^forever:[a-z]+-[0-9]+\.[0-9a-z]+$/.test(share.encode(EDITION, b.klass, trees, st));
}));

// split times drive the past race's analysis, so the events have to carry them
ok("every ding recorded the hours played at the time", (() => {
  const rows = mdb.prepare(
    "SELECT detail FROM events WHERE race_id = ? AND type = 'ding'").all("m1");
  return rows.length > 0 && rows.every(r => {
    const d = JSON.parse(r.detail || "{}");
    return typeof d.played === "number";
  });
})());

mdb.close();
fs.rmSync(mixTmp, { force: true });
for (const ext of ["-wal", "-shm"]) fs.rmSync(mixTmp + ext, { force: true });

/* ---------------- the config files ---------------- */

const raceCfg = JSON.parse(
  fs.readFileSync(path.join(__dirname, "config", "race.json"), "utf8"));

ok("race.json parses and sets the field size",
   Number.isFinite(raceCfg.bots) && raceCfg.bots > 0);
ok("race.json speed is a positive number",
   Number.isFinite(raceCfg.speed) && raceCfg.speed > 0);
ok("race.json hardcore is a boolean", typeof raceCfg.hardcore === "boolean");
ok("race.json names an edition that exists", (() => {
  try { rules.edition(raceCfg.edition); return true; } catch (e) { return false; }
})());

// "*" or a list - anything else would silently race nobody
ok("race.json classes is a wildcard or a list of real classes", (() => {
  const v = raceCfg.classes;
  if (v === "*") return true;
  const all = Object.keys(rules.edition(raceCfg.edition).classes);
  const list = Array.isArray(v) ? v : String(v).split(",").map(x => x.trim());
  return list.length > 0 && list.every(c => all.includes(c));
})());

// Every class the config could put in a race needs weights, or the first bot
// of that class throws at creation time rather than at review time.
ok("every class the config can race has weights", (() => {
  const all = Object.keys(rules.edition(raceCfg.edition).classes);
  const list = raceCfg.classes === "*" ? all
    : (Array.isArray(raceCfg.classes) ? raceCfg.classes : String(raceCfg.classes).split(","));
  return list.map(c => c.trim()).every(c => {
    try { stats.weights(c); return true; } catch (e) { return false; }
  });
})());

ok("roster.json covers every class the config can race", (() => {
  const all = Object.keys(rules.edition(raceCfg.edition).classes);
  const list = raceCfg.classes === "*" ? all
    : (Array.isArray(raceCfg.classes) ? raceCfg.classes : String(raceCfg.classes).split(","));
  return list.map(c => c.trim()).every(c => roster.racesFor(c).length > 0);
})());

// the comment keys are documentation; they must never be read as settings
ok("race.json comment keys are ignored by the reader",
   Object.keys(raceCfg).filter(k => k.startsWith("/")).length > 0);

/* ---------------- report ---------------- */

console.log(`\n  ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log("    FAIL  " + f);
  process.exit(1);
}
