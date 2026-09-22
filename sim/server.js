#!/usr/bin/env node
"use strict";
/**
 * The race server: a tick loop and a little JSON API in front of it.
 *
 * It keeps one race running at all times. When everybody has finished or died
 * it pauses for a moment and starts another, so there is always something to
 * watch and the thing can simply be left running.
 *
 * Environment:
 *   PORT            5503
 *   SIM_DB          data/sim.db
 *   SIM_SPEED       sim minutes per real second (default 30, so a race takes
 *                   about twenty minutes to resolve)
 *   SIM_BOTS        30
 *   SIM_HARDCORE    1 to make death permanent
 *   BASE_PATH       /sim
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

const db_ = require("./db");
const race_ = require("./race");
const rules = require("./rules");
const stats = require("./stats");
const share = require("./share");
const routes = require("./routes");
const roster = require("./roster");
const engine = require("./engine");
const xp = require("./xp");

const PORT = Number(process.env.PORT || 5503);
const DB_PATH = process.env.SIM_DB || path.join(__dirname, "..", "data", "sim.db");
// Sim minutes per real second. The default is ambient rather than a demo: a
// race takes most of a working day, so there is something to come back to
// rather than a whole 1-60 flashing past while you watch. Push it to 30+ if you
// want one to resolve in a sitting.
const SPEED = Number(process.env.SIM_SPEED || 1);
const BOTS = Number(process.env.SIM_BOTS || 30);
const HARDCORE = process.env.SIM_HARDCORE === "1";
const EDITION = process.env.SIM_EDITION || "forever";
// "*" for every class the edition has, or a comma-separated list. A mixed
// field is the only way both factions appear: no single class is open to all
// eight races.
const CLASS_SPEC = process.env.SIM_CLASS || "*";
const BASE = (process.env.BASE_PATH || "/sim").replace(/\/$/, "");
const INTERMISSION_SECONDS = Number(process.env.SIM_INTERMISSION || 20);
// where the talent calculator lives, so "open this build" goes somewhere real
const CALC_BASE = process.env.SIM_CALC_BASE || "/";

const db = db_.open(DB_PATH);
const q = db_.statements(db);

const ALL_CLASSES = Object.keys(rules.edition(EDITION).classes);
const CLASSES = CLASS_SPEC === "*"
  ? ALL_CLASSES
  : CLASS_SPEC.split(",").map(c => c.trim()).filter(c => ALL_CLASSES.includes(c));
if (!CLASSES.length) throw new Error(`SIM_CLASS "${CLASS_SPEC}" matched no class in ${EDITION}`);

const treeCache = new Map();
const treesFor = klass => {
  if (!treeCache.has(klass)) treeCache.set(klass, rules.classData(EDITION, klass).trees);
  return treeCache.get(klass);
};

/* ---------------- the running race ---------------- */

let current = null;          // { race, bots }
let intermissionUntil = 0;

function startRace() {
  const n = db.prepare("SELECT COUNT(*) n FROM races").get().n + 1;
  const id = "r" + String(n).padStart(4, "0");
  current = race_.createRace(db, q, {
    id, name: "Race #" + n, editionId: EDITION, classes: CLASSES,
    count: BOTS, seed: (Date.now() ^ (n * 2654435761)) >>> 0, hardcore: HARDCORE,
  });
  console.log(`started ${id} - ${BOTS} bots across ${CLASSES.length} ` +
    `class${CLASSES.length === 1 ? "" : "es"}${HARDCORE ? ", hardcore" : ""}`);
}

function resumeOrStart() {
  const running = db.prepare(
    "SELECT id FROM races WHERE status = 'running' ORDER BY created_at DESC LIMIT 1").get();
  if (running) {
    current = race_.loadRace(db, q, running.id);
    console.log(`resumed ${running.id} at minute ${current.race.minutes}`);
  } else {
    startRace();
  }
}

resumeOrStart();

/*
 * The race advances in whole ten-minute ticks, so a speed below ten cannot be
 * honoured one second at a time - asking advance() for one minute would still
 * step a full tick and quietly run ten times too fast. Bank the fractions here
 * and only spend whole ticks.
 */
let owed = 0;

setInterval(() => {
  if (intermissionUntil) {
    if (Date.now() >= intermissionUntil) { intermissionUntil = 0; owed = 0; startRace(); }
    return;
  }
  owed += SPEED;
  if (owed < engine.TICK_MINUTES) return;

  const spend = Math.floor(owed / engine.TICK_MINUTES) * engine.TICK_MINUTES;
  owed -= spend;

  const { done } = race_.advance(db, q, current.race, current.bots, spend);
  if (done) {
    console.log(`${current.race.id} finished at minute ${current.race.minutes}`);
    intermissionUntil = Date.now() + INTERMISSION_SECONDS * 1000;
  }
}, 1000);

/* ---------------- views ---------------- */

const botOf = id => current.bots.find(b => b.id === id);

function buildRate(s) {
  const T = engine.TUNING;
  return (1 + s.power * T.powerK) * (1 + s.aoe * T.aoeK)
       * (1 - T.baseDowntime / (1 + s.sustain * T.sustainK));
}

function topTalents(trees, st, n = 5) {
  const all = [];
  for (const tree of trees) {
    for (const tal of tree.talents) {
      const rank = st[tree.id][tal.id];
      if (rank) all.push({ tree: tree.id, id: tal.id, rank, maxRank: tal.maxRank, icon: tal.icon });
    }
  }
  // deepest investment first, then the ones closest to being maxed
  all.sort((a, b) => b.rank - a.rank || (b.rank / b.maxRank) - (a.rank / a.maxRank));
  return all.slice(0, n);
}

function boardView() {
  return q.board.all(current.race.id).map(b => {
    const bot = botOf(b.bot_id);
    const klass = b.klass || (bot && bot.klass) || CLASSES[0];
    const trees = treesFor(klass);
    const s = bot ? stats.statsAtStep(klass, trees, bot.route, b.step) : stats.zero();
    // where they are NOW, not where the route ends up - the stored spec is the
    // finished build, and showing it would give away the plan
    const spec = bot ? routes.describe(trees, rules.replay(trees, bot.route, b.step)) : "";
    // points per tree, so the page can draw the split rather than parse a string
    const st = bot ? rules.replay(trees, bot.route, b.step) : null;
    // an ordered list, not a keyed object: two classes have different trees and
    // the page colours them by position
    const split = trees.map(t => ({
      tree: t.id, name: t.name, icon: t.icon,
      points: st ? rules.treePoints(t, st) : 0,
    }));
    const lead = split.reduce((a, x) => (x.points > a.points ? x : a), split[0]);
    return {
      id: b.bot_id, name: b.name, spec,
      race: b.race || null, faction: b.faction || null, gender: b.gender || null,
      raceIcon: bot && bot.raceIcon ? bot.raceIcon : null,
      factionIcon: bot && bot.factionIcon ? bot.factionIcon : null,
      factionColour: bot ? bot.factionColour : null,
      classIcon: roster.classIcon(klass),

      klass,
      split, lead: lead.points > 0 ? lead.tree : null,
      leadIndex: lead.points > 0 ? split.findIndex(x => x.tree === lead.tree) : -1,

      level: b.level, points: b.step,
      progress: b.level >= xp.MAX_LEVEL ? 1 : b.xp / xp.toNext(b.level),
      deaths: b.deaths, alive: !!b.alive,
      played: b.played_minutes, finishedAt: b.finished_at,
      online: bot ? engine.online(bot, current.race.minutes) : false,
      stats: s, rate: buildRate(s),
      advantage: bot ? engine.xpPerHour(bot, s) / Math.max(1, engine.xpPerHour(bot, stats.zero())) : 1,
      code: st ? share.encode(EDITION, klass, trees, st) : null,
      top: st ? topTalents(trees, st) : [],
    };
  });
}

/*
 * The four stats are abstractions, and an abstraction on a bar chart tells you
 * nothing. Translate them into what they actually buy: kill speed, time sat
 * drinking, deaths per hour, and how much faster this build is than the same
 * character with no talents at all.
 */
function effectsOf(bot) {
  const T = engine.TUNING;
  const s = stats.statsAtStep(bot.klass, treesFor(bot.klass), bot.route, bot.step);
  const none = stats.zero();
  const hc = { hardcore: !!current.race.hardcore };
  return {
    killSpeed: 1 + s.power * T.powerK,
    downtime: T.baseDowntime / (1 + s.sustain * T.sustainK),
    baseDowntime: T.baseDowntime,
    deathsPerHour: engine.deathChance(bot, s, hc) * (60 / engine.TICK_MINUTES),
    bareDeathsPerHour: engine.deathChance(bot, none, hc) * (60 / engine.TICK_MINUTES),
    aoeBonus: s.aoe * T.aoeK,
    // the headline: xp per hour against the same character with nothing spent
    advantage: engine.xpPerHour(bot, s) / Math.max(1, engine.xpPerHour(bot, none)),
  };
}

function progressOf(bot) {
  if (bot.level >= xp.MAX_LEVEL) {
    return { progress: 1, xp: 0, xpNeeded: 0, xpPerHour: 0, etaPlayed: null, etaRace: null, nextTalent: null };
  }
  const need = xp.toNext(bot.level);
  const s = stats.statsAtStep(bot.klass, treesFor(bot.klass), bot.route, bot.step);
  const rate = engine.xpPerHour(bot, s);
  const toGo = Math.max(0, need - bot.xp);
  const etaPlayed = rate > 0 ? (toGo / rate) * 60 : null;          // minutes at the keyboard
  // they are only online part of the day, so wall-clock is longer
  const etaRace = etaPlayed == null ? null : etaPlayed * (24 / Math.max(0.1, bot.hoursPerDay));
  const step = bot.step < bot.route.length ? bot.route[bot.step] : null;
  return {
    progress: bot.xp / need,
    xp: Math.round(bot.xp), xpNeeded: need,
    xpPerHour: Math.round(rate),
    etaPlayed, etaRace,
    nextTalent: step ? { tree: step.tree, talent: step.talent } : null,
  };
}

function botView(id) {
  const bot = botOf(id);
  if (!bot) return null;
  const row = db.prepare("SELECT * FROM bots WHERE race_id = ? AND id = ?")
    .get(current.race.id, id);
  const trees = treesFor(bot.klass);
  const st = rules.replay(trees, bot.route, bot.step);
  const seen = {};
  const plan = bot.route.map((step, i) => {
    const key = step.tree + "::" + step.talent;
    const rank = (seen[key] = (seen[key] || 0) + 1);
    const tree = trees.find(t => t.id === step.tree);
    const tal = tree && tree.talents.find(t => t.id === step.talent);
    return {
      level: rules.levelForStep(i),
      tree: step.tree, talent: step.talent,
      rank, maxRank: tal ? tal.maxRank : rank,
      icon: tal ? tal.icon : null,
      taken: i < bot.step,
    };
  });
  return {
    id: bot.id, name: bot.name, klass: bot.klass,
    race: bot.race || null, faction: bot.faction || null, gender: bot.gender || null,
    raceIcon: bot.raceIcon || null, factionIcon: bot.factionIcon || null,
    factionColour: bot.factionColour || null, classIcon: roster.classIcon(bot.klass),
    spec: routes.describe(trees, st),
    level: bot.level, points: bot.step, deaths: bot.deaths,
    alive: bot.alive, played: bot.playedMinutes, finishedAt: bot.finishedAt,
    stats: stats.statsAtStep(bot.klass, trees, bot.route, bot.step),
    // how close they are to the next level, and - from their own build and
    // play style - roughly how long it will take them to get there
    ...progressOf(bot),
    effects: effectsOf(bot),
    // personality, which is half the story of why they are winning or losing
    recklessness: bot.recklessness, hoursPerDay: bot.hoursPerDay,
    // the build as it stands right now, in the calculator's own language
    code: share.encode(EDITION, bot.klass, trees, st),
    plan,
  };
}

// Built once at boot: tree -> talent -> everything a tooltip needs.
const TALENT_DICT = (() => {
  const out = { edition: EDITION, classes: {} };
  for (const klass of CLASSES) {
    const entry = { icon: roster.classIcon(klass), trees: [] };
    for (const tree of treesFor(klass)) {
      const t = { id: tree.id, name: tree.name, icon: tree.icon, talents: {} };
      for (const tal of tree.talents) {
        t.talents[tal.id] = {
          name: tal.name, icon: tal.icon, pos: tal.pos,
          maxRank: tal.maxRank, reqPoints: tal.reqPoints,
          prereq: tal.prereq || null, ranks: tal.ranks,
        };
      }
      entry.trees.push(t);
    }
    out.classes[klass] = entry;
  }
  return out;
})();

/* ---------------- http ---------------- */

const PAGE = path.join(__dirname, "public", "watch.html");

// Read once at boot and the placeholders filled in, so the page never has to
// guess where it is mounted - relative URLs break the moment someone lands on
// /sim instead of /sim/.
const HTML = fs.readFileSync(PAGE, "utf8")
  .split("__CALC__").join(CALC_BASE)
  .split("__BASE__").join(BASE)
  .split('"api/').join('"' + BASE + '/api/');

function send(res, code, body, type = "application/json") {
  const buf = Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  res.writeHead(code, {
    "Content-Type": type,
    "Content-Length": buf.length,
    "Cache-Control": "no-store",
  });
  res.end(buf);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  let p = url.pathname;
  if (BASE && p.startsWith(BASE)) p = p.slice(BASE.length) || "/";

  if (req.method !== "GET") return send(res, 405, { error: "GET only" });

  // the edition's own logo, straight out of the calculator's assets
  if (p === "/logo.png") {
    const file = path.join(__dirname, "..", "src", "logos", EDITION + ".png");
    if (fs.existsSync(file)) {
      const buf = fs.readFileSync(file);
      res.writeHead(200, {
        "Content-Type": "image/png",
        "Content-Length": buf.length,
        "Cache-Control": "public, max-age=86400",
      });
      return res.end(buf);
    }
    return send(res, 404, { error: "no logo" });
  }

  if (p === "/" || p === "/index.html" || p === "/watch.html") {
    return send(res, 200, HTML, "text/html; charset=utf-8");
  }

  if (p === "/api/state") {
    return send(res, 200, {
      race: {
        id: current.race.id, name: current.race.name,
        minutes: current.race.minutes, status: current.race.status,
        hardcore: !!current.race.hardcore, edition: EDITION,
        classes: CLASSES, mixed: CLASSES.length > 1,
        maxLevel: xp.MAX_LEVEL,
      },
      speed: SPEED,
      intermission: intermissionUntil ? Math.max(0, intermissionUntil - Date.now()) : 0,
      board: boardView(),
    });
  }

  if (p === "/api/feed") {
    const after = Number(url.searchParams.get("after") || 0);
    const rows = db.prepare(
      `SELECT e.id, e.bot_id, e.at_minutes, e.type, e.level, e.detail, b.name
       FROM events e JOIN bots b ON b.race_id = e.race_id AND b.id = e.bot_id
       WHERE e.race_id = ? AND e.id > ? AND e.type IN ('ding','death','finish')
       ORDER BY e.id DESC LIMIT 60`).all(current.race.id, after);
    return send(res, 200, rows.map(r => ({
      id: r.id, bot: r.bot_id, name: r.name, at: r.at_minutes,
      type: r.type, level: r.level, detail: JSON.parse(r.detail),
    })));
  }

  const bot = p.match(/^\/api\/bot\/(.+)$/);
  if (bot) {
    const view = botView(decodeURIComponent(bot[1]));
    return view ? send(res, 200, view) : send(res, 404, { error: "no such bot" });
  }

  // Level over time, which is what makes a race legible - the standings alone
  // never show you the overtake. Incremental: pass the last id you saw.
  if (p === "/api/history") {
    const after = Number(url.searchParams.get("after") || 0);
    const rows = db.prepare(
      `SELECT id, bot_id, at_minutes, level, type, detail FROM events
       WHERE race_id = ? AND id > ? AND type IN ('ding','death','finish')
       ORDER BY id LIMIT 6000`).all(current.race.id, after);
    const tracks = {}, deaths = {}, finishes = {};
    for (const r of rows) {
      if (r.type === "ding") {
        // [race minute, level, minutes played] - the third is the split time
        const d = JSON.parse(r.detail || "{}");
        (tracks[r.bot_id] ||= []).push([r.at_minutes, r.level, d.played == null ? null : d.played]);
      }
      else if (r.type === "death") (deaths[r.bot_id] ||= []).push([r.at_minutes, r.level]);
      else finishes[r.bot_id] = [r.at_minutes, r.level];
    }
    return send(res, 200, {
      maxId: rows.length ? rows[rows.length - 1].id : after,
      minutes: current.race.minutes,
      tracks, deaths, finishes,
    });
  }

  // Past races, with who won and how long it took them
  if (p === "/api/history/races" || p === "/api/past") {
    const races = q.listRaces.all(12);
    return send(res, 200, races.map(r => {
      const win = db.prepare(
        `SELECT b.name, s.played_minutes, s.finished_at, b.spec
         FROM bot_state s JOIN bots b ON b.race_id = s.race_id AND b.id = s.bot_id
         WHERE s.race_id = ? AND s.finished_at IS NOT NULL
         ORDER BY s.finished_at LIMIT 1`).get(r.id);
      const n = db.prepare("SELECT COUNT(*) n FROM bots WHERE race_id = ?").get(r.id).n;
      const done = db.prepare(
        "SELECT COUNT(*) n FROM bot_state WHERE race_id = ? AND finished_at IS NOT NULL").get(r.id).n;
      return {
        id: r.id, name: r.name, status: r.status, minutes: r.minutes,
        hardcore: !!r.hardcore, bots: n, finished: done,
        winner: win ? { name: win.name, played: win.played_minutes, spec: win.spec } : null,
      };
    }));
  }

  // What the field as a whole is actually picking. More interesting than any
  // single build: it is the closest thing to a verdict the race produces.
  if (p === "/api/popularity") {
    const rows = q.board.all(current.race.id);
    const tally = {};
    const fieldByClass = {};
    for (const b of rows) {
      const bot = botOf(b.bot_id);
      if (!bot) continue;
      const trees = treesFor(bot.klass);
      fieldByClass[bot.klass] = (fieldByClass[bot.klass] || 0) + 1;
      const st = rules.replay(trees, bot.route, b.step);
      for (const tree of trees) {
        for (const tal of tree.talents) {
          const rank = st[tree.id][tal.id];
          if (!rank) continue;
          const k = bot.klass + "::" + tree.id + "::" + tal.id;
          const e = (tally[k] ||= {
            klass: bot.klass, tree: tree.id, treeIcon: tree.icon,
            treeIndex: trees.indexOf(tree),
            id: tal.id, icon: tal.icon,
            maxRank: tal.maxRank, bots: 0, ranks: 0, maxed: 0,
          });
          e.bots++; e.ranks += rank;
          if (rank >= tal.maxRank) e.maxed++;
        }
      }
    }
    // share is against that class's own field, not the whole race - "half the
    // Mages took it" means nothing if it is measured against thirty bots
    const list = Object.values(tally).map(e => ({
      ...e,
      avgRank: e.ranks / e.bots,
      share: e.bots / Math.max(1, fieldByClass[e.klass] || 1),
    })).sort((a, b) => b.share - a.share || b.avgRank - a.avgRank);
    return send(res, 200, { field: rows.length, byClass: fieldByClass, talents: list });
  }

  if (p === "/api/talents") {
    return send(res, 200, TALENT_DICT);
  }

  if (p === "/api/health") {
    return send(res, 200, { ok: true, race: current.race.id, minutes: current.race.minutes });
  }

  if (p === "/api/races") {
    return send(res, 200, q.listRaces.all(20));
  }

  send(res, 404, { error: "not found" });
});

server.listen(PORT, () => {
  console.log(`sim on http://localhost:${PORT}${BASE}/  (${SPEED} sim-minutes per second)`);
});
