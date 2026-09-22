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
const crypto = require("node:crypto");
const fs = require("fs");
const path = require("path");

const db_ = require("./db");
const race_ = require("./race");
const rules = require("./rules");
const stats = require("./stats");
const share = require("./share");
const ingest = require("./ingest");
const routes = require("./routes");
const roster = require("./roster");
const engine = require("./engine");
const xp = require("./xp");

/*
 * Settings come from config/race.json, and an environment variable overrides
 * whatever the file says. The file is the friendly place to change things; the
 * variables are there so a deployment can differ without editing it.
 */
const FILE = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, "config", "race.json"), "utf8"));
  } catch (e) {
    console.warn("config/race.json unreadable (" + e.message + "), using defaults");
    return {};
  }
})();

const pick = (env, key, dflt) => (process.env[env] !== undefined ? process.env[env]
  : (FILE[key] !== undefined ? FILE[key] : dflt));

const PORT = Number(process.env.PORT || 5503);
const DB_PATH = process.env.SIM_DB || path.join(__dirname, "..", "data", "sim.db");
// Sim minutes per real second. The default is ambient rather than a demo: a
// race takes most of a working day, so there is something to come back to
// rather than a whole 1-60 flashing past while you watch. Push it to 30+ if you
// want one to resolve in a sitting.
const SPEED = Number(pick("SIM_SPEED", "speed", 1));
const BOTS = Number(pick("SIM_BOTS", "bots", 30));
const HARDCORE = process.env.SIM_HARDCORE !== undefined
  ? process.env.SIM_HARDCORE === "1"
  : !!FILE.hardcore;
const EDITION = String(pick("SIM_EDITION", "edition", "forever"));
// "*" for every class the edition has, or a comma-separated list. A mixed
// field is the only way both factions appear: no single class is open to all
// eight races.
const CLASS_SPEC = (() => {
  const v = pick("SIM_CLASS", "classes", "*");
  return Array.isArray(v) ? v.join(",") : String(v);
})();
const BASE = (process.env.BASE_PATH || "/sim").replace(/\/$/, "");
const INTERMISSION_SECONDS = Number(pick("SIM_INTERMISSION", "intermission", 20));
/*
 * Writing is off unless a key is set. This serves on a public hostname, and an
 * open ingest endpoint would let anyone invent a race - so no key, no writes,
 * and the read-only site carries on as before.
 */
const INGEST_KEY = process.env.SIM_INGEST_KEY || "";

function authorised(req, url) {
  if (!INGEST_KEY) return false;
  const given = req.headers["x-ingest-key"] || url.searchParams.get("key") || "";
  const a = Buffer.from(String(given));
  const b = Buffer.from(INGEST_KEY);
  // compare in constant time, and only when the lengths already match, since
  // timingSafeEqual throws on a mismatch and that itself would leak the length
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const chunks = [];
    req.on("data", c => {
      n += c.length;
      if (n > limit) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); }
      catch (e) { reject(new Error("body is not json")); }
    });
    req.on("error", reject);
  });
}

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

/*
 * Past races are reconstructed from the database on demand: the bots table
 * holds each route and personality, so loadRace rebuilds exactly the field that
 * ran. Loading is not free, so the last few stay in memory - a finished race
 * never changes, which makes it safe to cache for as long as we like.
 */
const pastCache = new Map();
const PAST_CACHE_MAX = 6;

function raceContext(raceId) {
  if (!raceId || raceId === current.race.id) return current;
  if (pastCache.has(raceId)) return pastCache.get(raceId);

  const row = q.getRace.get(raceId);
  if (!row) return null;

  const loaded = race_.loadRace(db, q, raceId);
  pastCache.set(raceId, loaded);
  while (pastCache.size > PAST_CACHE_MAX) {
    pastCache.delete(pastCache.keys().next().value);
  }
  return loaded;
}

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

function boardView(ctx) {
  ctx = ctx || current;
  const find = id => ctx.bots.find(x => x.id === id);
  return q.board.all(ctx.race.id).map(b => {
    const bot = find(b.bot_id);
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
      online: bot ? engine.online(bot, ctx.race.minutes) : false,
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
function effectsOf(bot, ctx) {
  const T = engine.TUNING;
  const s = stats.statsAtStep(bot.klass, treesFor(bot.klass), bot.route, bot.step);
  const none = stats.zero();
  const hc = { hardcore: !!((ctx || current).race.hardcore) };
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

function botView(id, ctx) {
  ctx = ctx || current;
  const bot = ctx.bots.find(x => x.id === id);
  if (!bot) return null;
  const row = db.prepare("SELECT * FROM bots WHERE race_id = ? AND id = ?")
    .get(ctx.race.id, id);
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
    effects: effectsOf(bot, ctx),
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

/* ---------------- ingest ---------------- */

async function handleIngest(req, res, p, url) {
  if (!authorised(req, url)) {
    return send(res, INGEST_KEY ? 403 : 404, {
      error: INGEST_KEY ? "bad key" : "ingest is not enabled on this instance",
    });
  }

  let body;
  try { body = await readBody(req); }
  catch (e) { return send(res, 400, { error: e.message }); }

  try {
    // start a race that tracks real characters
    if (p === "/api/ingest/race") {
      if (!body.id) return send(res, 400, { error: "an id is required" });
      const race = ingest.createRealRace(db, q, {
        id: String(body.id), name: body.name || "Race",
        editionId: EDITION, startedAt: body.startedAt,
        hardcore: !!body.hardcore,
      });
      return send(res, 200, { ok: true, race });
    }

    // add someone to it
    if (p === "/api/ingest/character") {
      const race = q.getRace.get(String(body.raceId || ""));
      if (!race) return send(res, 404, { error: "no such race" });
      if (race.kind !== "real") return send(res, 400, { error: "that race is simulated" });
      const row = ingest.addCharacter(db, q, race, body);
      return send(res, 200, { ok: true, character: row });
    }

    // one reading, or a batch of them
    if (p === "/api/ingest" || p === "/api/ingest/observe") {
      const race = q.getRace.get(String(body.raceId || ""));
      if (!race) return send(res, 404, { error: "no such race" });
      if (race.kind !== "real") return send(res, 400, { error: "that race is simulated" });

      const list = Array.isArray(body.observations) ? body.observations : [body];
      const results = list.map(o => {
        try { return { botId: o.botId, ...ingest.record(db, q, race, o) }; }
        catch (e) { return { botId: o.botId, error: e.message }; }
      });
      // a real race's clock is wall clock, so move it on as readings arrive
      const now = ingest.minutesInto(race, new Date().toISOString());
      if (now > race.minutes) q.setMinutes.run(now, race.status, race.id);
      pastCache.delete(race.id);
      return send(res, 200, { ok: true, results });
    }

    return send(res, 404, { error: "not an ingest endpoint" });
  } catch (e) {
    return send(res, 400, { error: e.message });
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  let p = url.pathname;
  if (BASE && p.startsWith(BASE)) p = p.slice(BASE.length) || "/";

  if (req.method === "POST" && p.startsWith("/api/ingest")) {
    return handleIngest(req, res, p, url);
  }
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
        kind: current.race.kind || "sim",
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

  // a finished race in the same shape as the running one, so the page can draw
  // it with exactly the same code
  const oldBot = p.match(/^\/api\/race\/([^/]+)\/bot\/(.+)$/);
  if (oldBot) {
    const ctx = raceContext(decodeURIComponent(oldBot[1]));
    if (!ctx) return send(res, 404, { error: "no such race" });
    const view = botView(decodeURIComponent(oldBot[2]), ctx);
    return view ? send(res, 200, view) : send(res, 404, { error: "no such bot" });
  }

  const oldRace = p.match(/^\/api\/race\/([^/]+)$/);
  if (oldRace) {
    const id = decodeURIComponent(oldRace[1]);
    const ctx = raceContext(id);
    if (!ctx) return send(res, 404, { error: "no such race" });
    const board = boardView(ctx);
    const classes = [...new Set(board.map(b => b.klass))];
    return send(res, 200, {
      race: {
        id: ctx.race.id, name: ctx.race.name, minutes: ctx.race.minutes,
        status: ctx.race.status, hardcore: !!ctx.race.hardcore,
        kind: ctx.race.kind || "sim",
        edition: EDITION, classes, mixed: classes.length > 1,
        maxLevel: xp.MAX_LEVEL, createdAt: ctx.race.created_at,
        live: ctx.race.id === current.race.id,
      },
      board,
      // the same history the live chart runs on, so a finished race can be
      // drawn the same way rather than as a table of end results
      history: (() => {
        const rows = db.prepare(
          `SELECT bot_id, at_minutes, level, type, detail FROM events
           WHERE race_id = ? AND type IN ('ding','death','finish') ORDER BY id`).all(id);
        const tracks = {}, deaths = {}, finishes = {};
        for (const r of rows) {
          if (r.type === "ding") {
            const d = JSON.parse(r.detail || "{}");
            (tracks[r.bot_id] ||= []).push([r.at_minutes, r.level, d.played == null ? null : d.played]);
          } else if (r.type === "death") (deaths[r.bot_id] ||= []).push([r.at_minutes, r.level]);
          else finishes[r.bot_id] = [r.at_minutes, r.level];
        }
        return { tracks, deaths, finishes };
      })(),
    });
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
        `SELECT b.name, s.played_minutes, s.finished_at, b.spec, b.klass, b.race, b.faction
         FROM bot_state s JOIN bots b ON b.race_id = s.race_id AND b.id = s.bot_id
         WHERE s.race_id = ? AND s.finished_at IS NOT NULL
         ORDER BY s.finished_at LIMIT 1`).get(r.id);
      const n = db.prepare("SELECT COUNT(*) n FROM bots WHERE race_id = ?").get(r.id).n;
      const podium = db.prepare(
        `SELECT b.name, b.klass, b.race, b.faction, b.spec, s.played_minutes, s.level
         FROM bot_state s JOIN bots b ON b.race_id = s.race_id AND b.id = s.bot_id
         WHERE s.race_id = ?
         ORDER BY (s.finished_at IS NULL), s.finished_at, s.level DESC, s.xp DESC
         LIMIT 3`).all(r.id);
      const classes = db.prepare(
        "SELECT DISTINCT klass FROM bots WHERE race_id = ?").all(r.id).map(x => x.klass);
      const done = db.prepare(
        "SELECT COUNT(*) n FROM bot_state WHERE race_id = ? AND finished_at IS NOT NULL").get(r.id).n;
      return {
        id: r.id, name: r.name, status: r.status, minutes: r.minutes,
        hardcore: !!r.hardcore, bots: n, finished: done,
        createdAt: r.created_at, classes,
        podium: podium.map(x => ({
          name: x.name, klass: x.klass, race: x.race, faction: x.faction,
          spec: x.spec, played: x.played_minutes, level: x.level,
        })),
        winner: win ? {
          name: win.name, played: win.played_minutes, spec: win.spec,
          klass: win.klass, race: win.race, faction: win.faction,
        } : null,
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

  // Where a race's numbers came from and how old they are. An armory only
  // updates on logout, so this is the number that says whether a standing is
  // worth believing.
  const prov = p.match(/^\/api\/race\/([^/]+)\/provenance$/);
  if (prov) {
    const raceId = decodeURIComponent(prov[1]);
    const row = q.getRace.get(raceId);
    if (!row) return send(res, 404, { error: "no such race" });
    return send(res, 200, {
      kind: row.kind || "sim",
      startedAt: row.started_at || row.created_at,
      staleness: ingest.staleness(q, raceId),
      recent: ingest.recent(q, raceId, 40).map(o => ({
        bot: o.bot_id, name: o.name, source: o.source,
        observedAt: o.observed_at, at: o.at_minutes,
        level: o.level, played: o.played, note: o.note,
      })),
    });
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
  console.log(`sim on http://localhost:${PORT}${BASE}/`);
  console.log(`  ${BOTS} bots \u00b7 ${CLASSES.length} class${CLASSES.length === 1 ? "" : "es"}` +
    ` \u00b7 ${SPEED} sim-min/sec \u00b7 ${HARDCORE ? "hardcore" : "normal"} \u00b7 ${EDITION}`);
});
