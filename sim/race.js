"use strict";
/**
 * Creating and advancing a race.
 *
 * Advancing is resumable: a race is a row plus its events, so the tick loop can
 * stop, the process can be redeployed, and it carries on from the minute it had
 * reached. Nothing is lost and nothing is re-simulated.
 */

const rules = require("./rules");
const routes = require("./routes");
const stats = require("./stats");
const engine = require("./engine");
const roster = require("./roster");
const { rng, seedFrom } = require("./rng");

/* ---------------- creation ---------------- */

function createRace(db, q, opts) {
  const {
    id, name = "Levelling race", editionId = "forever",
    count = 30, seed = Date.now() >>> 0, hardcore = false,
  } = opts;
  // one class, or a field of several - a mixed field is the only way to see
  // both factions, since no single class is open to all eight races
  const classes = opts.classes && opts.classes.length
    ? opts.classes
    : [opts.klass || "Shaman"];

  const edition = rules.edition(editionId);
  const r = rng(seed);
  const taken = new Set();

  const now = new Date().toISOString();
  q.createRace.run(id, name, editionId, seed, hardcore ? 1 : 0, now, "sim", now);

  const bots = [];
  for (let i = 0; i < count; i++) {
    const who = roster.rollAny(classes, r, taken);
    const klass = who.klass;
    const { trees } = rules.classData(editionId, klass);
    const botName = who.name;
    const botSeed = seedFrom(seed + "::" + botName);   // the seed, not the id, so --seed reproduces the race
    const br = rng(botSeed);

    const bias = routes.randomBias(trees, br);
    // the rest of a personality: how long they play, when, and how carefully
    // people play hardcore more carefully, but not uniformly so - the spread
    // is what makes some of them die
    bias.recklessness = hardcore ? br.range(0, 0.6) : br.range(0, 1);
    bias.hoursPerDay = br.range(4, 15);
    bias.startHour = br.range(0, 24);

    const route = routes.generate(klass, trees, edition.maxPoints, bias, br);
    const spec = routes.describe(trees, rules.replay(trees, route));

    q.addBot.run(id, botName, botName, klass, spec,
      who.race, who.faction, who.gender, botSeed,
      JSON.stringify(route), JSON.stringify(bias),
      "sim", "", "");

    const bot = engine.newBot({
      id: botName, name: botName, klass, editionId, route, bias,
      rng: rng(botSeed ^ 0x9e3779b9),
    });
    Object.assign(bot, {
      klass,
      race: who.race, faction: who.faction, gender: who.gender,
      raceIcon: who.raceIcon, factionIcon: who.factionIcon, factionColour: who.factionColour,
    });
    bots.push(bot);
    q.putState.run(id, bot.id, bot.level, bot.xp, bot.step, bot.deaths, 1, 0, null);
  }
  return { race: q.getRace.get(id), bots };
}

/* ---------------- loading ---------------- */

function loadRace(db, q, id) {
  const race = q.getRace.get(id);
  if (!race) throw new Error("no race " + id);

  const bots = q.listBots.all(id).map(rowBot => {
    const route = JSON.parse(rowBot.route);
    const bias = JSON.parse(rowBot.bias);
    const bot = engine.newBot({
      id: rowBot.id, name: rowBot.name, klass: rowBot.klass,
      editionId: race.edition, route, bias,
      rng: rng(rowBot.seed ^ 0x9e3779b9),
    });
    Object.assign(bot, {
      race: rowBot.race, faction: rowBot.faction, gender: rowBot.gender,
      raceIcon: rowBot.race
        ? (roster.CONFIG.races[rowBot.race] || {}).icon + "_" + rowBot.gender : null,
      factionIcon: (roster.CONFIG.factions[rowBot.faction] || {}).icon || null,
      factionColour: (roster.CONFIG.factions[rowBot.faction] || {}).colour || "#8b8579",
    });
    const st = db.prepare("SELECT * FROM bot_state WHERE race_id = ? AND bot_id = ?")
      .get(id, rowBot.id);
    if (st) {
      Object.assign(bot, {
        level: st.level, xp: st.xp, step: st.step, deaths: st.deaths,
        alive: !!st.alive, playedMinutes: st.played_minutes,
        finishedAt: st.finished_at,
      });
      // The RNG stream is not replayed on resume. A race that is stopped and
      // restarted diverges from one that ran straight through - which is fine,
      // because the events already written are what happened.
      for (let i = 0; i < st.played_minutes; i++) bot.rng();
    }
    return bot;
  });
  return { race, bots };
}

/* ---------------- running ---------------- */

function advance(db, q, race, bots, simMinutes) {
  const hardcore = !!race.hardcore;
  let at = race.minutes;
  const until = at + simMinutes;

  const write = db.prepare(`INSERT INTO events (race_id, bot_id, at_minutes, type, level, detail)
                            VALUES (?, ?, ?, ?, ?, ?)`);

  while (at < until) {
    at += engine.TICK_MINUTES;
    let anyRunning = false;

    for (const bot of bots) {
      if (bot.alive && bot.finishedAt === null) anyRunning = true;
      const events = engine.tick(bot, at, { hardcore });
      for (const e of events) {
        const { type, level, ...detail } = e;
        write.run(race.id, bot.id, at, type, level, JSON.stringify(detail));
      }
      if (events.length) {
        q.putState.run(race.id, bot.id, bot.level, bot.xp, bot.step, bot.deaths,
          bot.alive ? 1 : 0, bot.playedMinutes, bot.finishedAt);
      }
    }
    if (!anyRunning) break;
  }

  // flush state for everyone, so played_minutes is right even for a quiet tick
  for (const bot of bots) {
    q.putState.run(race.id, bot.id, bot.level, bot.xp, bot.step, bot.deaths,
      bot.alive ? 1 : 0, bot.playedMinutes, bot.finishedAt);
  }

  const done = bots.every(b => !b.alive || b.finishedAt !== null);
  q.setMinutes.run(at, done ? "finished" : "running", race.id);
  race.minutes = at;
  return { at, done };
}

module.exports = { createRace, loadRace, advance };
