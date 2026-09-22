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
const engine = require("./engine");
const xp = require("./xp");

const PORT = Number(process.env.PORT || 5503);
const DB_PATH = process.env.SIM_DB || path.join(__dirname, "..", "data", "sim.db");
const SPEED = Number(process.env.SIM_SPEED || 30);
const BOTS = Number(process.env.SIM_BOTS || 30);
const HARDCORE = process.env.SIM_HARDCORE === "1";
const EDITION = process.env.SIM_EDITION || "forever";
const KLASS = process.env.SIM_CLASS || "Shaman";
const BASE = (process.env.BASE_PATH || "/sim").replace(/\/$/, "");
const INTERMISSION_SECONDS = Number(process.env.SIM_INTERMISSION || 20);
// where the talent calculator lives, so "open this build" goes somewhere real
const CALC_BASE = process.env.SIM_CALC_BASE || "/";

const db = db_.open(DB_PATH);
const q = db_.statements(db);
const { trees } = rules.classData(EDITION, KLASS);

/* ---------------- the running race ---------------- */

let current = null;          // { race, bots }
let intermissionUntil = 0;

function startRace() {
  const n = db.prepare("SELECT COUNT(*) n FROM races").get().n + 1;
  const id = "r" + String(n).padStart(4, "0");
  current = race_.createRace(db, q, {
    id, name: "Race #" + n, editionId: EDITION, klass: KLASS,
    count: BOTS, seed: (Date.now() ^ (n * 2654435761)) >>> 0, hardcore: HARDCORE,
  });
  console.log(`started ${id} - ${BOTS} ${KLASS}s${HARDCORE ? ", hardcore" : ""}`);
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

setInterval(() => {
  if (intermissionUntil) {
    if (Date.now() >= intermissionUntil) { intermissionUntil = 0; startRace(); }
    return;
  }
  const { done } = race_.advance(db, q, current.race, current.bots, SPEED);
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

function boardView() {
  return q.board.all(current.race.id).map(b => {
    const bot = botOf(b.bot_id);
    const s = bot ? stats.statsAtStep(KLASS, trees, bot.route, b.step) : stats.zero();
    // where they are NOW, not where the route ends up - the stored spec is the
    // finished build, and showing it would give away the plan
    const spec = bot ? routes.describe(trees, rules.replay(trees, bot.route, b.step)) : "";
    return {
      id: b.bot_id, name: b.name, spec,
      level: b.level, points: b.step,
      progress: b.level >= xp.MAX_LEVEL ? 1 : b.xp / xp.toNext(b.level),
      deaths: b.deaths, alive: !!b.alive,
      played: b.played_minutes, finishedAt: b.finished_at,
      online: bot ? engine.online(bot, current.race.minutes) : false,
      stats: s, rate: buildRate(s),
    };
  });
}

function botView(id) {
  const bot = botOf(id);
  if (!bot) return null;
  const row = db.prepare("SELECT * FROM bots WHERE race_id = ? AND id = ?")
    .get(current.race.id, id);
  const st = rules.replay(trees, bot.route, bot.step);
  const plan = bot.route.map((step, i) => ({
    level: rules.levelForStep(i),
    tree: step.tree, talent: step.talent,
    taken: i < bot.step,
  }));
  return {
    id: bot.id, name: bot.name, klass: bot.klass,
    spec: routes.describe(trees, st),
    level: bot.level, points: bot.step, deaths: bot.deaths,
    alive: bot.alive, played: bot.playedMinutes, finishedAt: bot.finishedAt,
    stats: stats.statsAtStep(KLASS, trees, bot.route, bot.step),
    // personality, which is half the story of why they are winning or losing
    recklessness: bot.recklessness, hoursPerDay: bot.hoursPerDay,
    // the build as it stands right now, in the calculator's own language
    code: share.encode(EDITION, KLASS, trees, st),
    plan,
  };
}

/* ---------------- http ---------------- */

const PAGE = path.join(__dirname, "public", "watch.html");

// Read once at boot and the placeholders filled in, so the page never has to
// guess where it is mounted - relative URLs break the moment someone lands on
// /sim instead of /sim/.
const HTML = fs.readFileSync(PAGE, "utf8")
  .split("__CALC__").join(CALC_BASE)
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

  if (p === "/" || p === "/index.html" || p === "/watch.html") {
    return send(res, 200, HTML, "text/html; charset=utf-8");
  }

  if (p === "/api/state") {
    return send(res, 200, {
      race: {
        id: current.race.id, name: current.race.name,
        minutes: current.race.minutes, status: current.race.status,
        hardcore: !!current.race.hardcore, edition: EDITION, klass: KLASS,
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
