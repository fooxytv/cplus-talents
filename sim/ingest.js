"use strict";
/**
 * Taking real observations and turning them into a race.
 *
 * The page draws a race, not a simulation, so a real one needs no new front
 * end - it needs a way in. That is this file.
 *
 * The rule everything here follows: an OBSERVATION is a fact about a reading
 * ("at 14:02 this source said Bella was level 23"), an EVENT is our reading of
 * it ("Bella reached 23"). Observations are kept verbatim and forever; events
 * are derived from them. Keeping both is what makes a source that lags, lies or
 * contradicts another visible instead of silently rewriting the race.
 *
 * What this cannot do, and does not pretend to:
 *
 * - Blizzard's profile API does not expose /played. For a real character the
 *   hours-at-the-keyboard number simply is not available, so bot_state carries
 *   played_known = 0 and anything that compares split times has to fall back to
 *   wall clock and say so.
 * - An armory only updates when the character logs out. A reading is therefore
 *   a lower bound with an unknown lag, never "the level right now".
 */

const rules = require("./rules");
const stats = require("./stats");
const routes = require("./routes");
const share = require("./share");
const xp = require("./xp");

const SOURCES = ["manual", "armory", "addon", "sim"];

/* ---------------- creating a real race ---------------- */

function createRealRace(db, q, opts) {
  const {
    id, name = "Race", editionId = "forever",
    startedAt = new Date().toISOString(), hardcore = false,
  } = opts;

  q.createRace.run(id, name, editionId, 0, hardcore ? 1 : 0,
    new Date().toISOString(), "real", startedAt);
  return q.getRace.get(id);
}

/** How far into the race a moment is, in minutes. */
function minutesInto(race, whenISO) {
  const start = Date.parse(race.started_at || race.created_at);
  const at = Date.parse(whenISO);
  if (!Number.isFinite(start) || !Number.isFinite(at)) return race.minutes || 0;
  return Math.max(0, Math.round((at - start) / 60000));
}

/**
 * Add a character to a real race. Unlike a bot it has no route: what it has
 * spent is whatever the last observation said, so the route starts empty and
 * is replaced as talents are reported.
 */
function addCharacter(db, q, race, who) {
  const { id, name, klass, realm = "", region = "", source = "manual" } = who;
  const charRace = who.race || "";
  const faction = who.faction || "";
  const gender = who.gender || "";

  // the class has to be one the edition knows, or nothing downstream works
  rules.classData(race.edition, klass);

  q.addBot.run(race.id, id || name, name, klass, "", charRace, faction, gender,
    0, "[]", "{}", source, realm, region);

  q.putState.run(race.id, id || name, 1, 0, 0, 0, 1, 0, null);
  q.setPlayedKnown.run(0, race.id, id || name);          // real: unknown until told
  return q.listBots.all(race.id).find(b => b.id === (id || name));
}

/* ---------------- recording what a source said ---------------- */

/**
 * Record one reading and derive whatever follows from it.
 *
 * Returns what changed, so a caller can tell "nothing new" from "gained four
 * levels" without re-reading the database.
 */
function record(db, q, race, obs) {
  const {
    botId, source, level = null, xp: xpNow = null, xpMax = null,
    played = null, talents = null, note = "", raw = {},
  } = obs;

  if (!SOURCES.includes(source)) {
    throw new Error(`unknown source "${source}" - expected one of ${SOURCES.join(", ")}`);
  }

  const observedAt = obs.observedAt || new Date().toISOString();
  const at = minutesInto(race, observedAt);

  const state = db.prepare("SELECT * FROM bot_state WHERE race_id = ? AND bot_id = ?")
    .get(race.id, botId);
  if (!state) throw new Error(`${botId} is not in race ${race.id}`);

  q.addObservation.run(race.id, botId, source, observedAt, new Date().toISOString(),
    at, level, xpNow, xpMax, played, talents ? JSON.stringify(talents) : null,
    JSON.stringify(raw), note);

  const changed = { levels: [], finished: false, talents: false, ignored: null };

  /*
   * A level that has gone backwards means the sources disagree, or somebody
   * mistyped. Record the observation - it happened - but do not act on it. A
   * race that can go backwards is worse than one that is briefly wrong.
   */
  if (level != null && level < state.level) {
    changed.ignored = `level ${level} is below the recorded ${state.level}`;
    return changed;
  }

  const write = q.addEvent;
  let newLevel = state.level;

  if (level != null && level > state.level) {
    // Only the arrival is known, not the climb: a reading can cross several
    // levels at once, and each one is stamped with the same moment because
    // that is genuinely all we know.
    for (let l = state.level + 1; l <= level; l++) {
      write.run(race.id, botId, at, "ding", l,
        JSON.stringify(played != null ? { played, source } : { source }));
      changed.levels.push(l);
    }
    newLevel = level;
  }

  if (newLevel >= xp.MAX_LEVEL && state.finished_at === null) {
    write.run(race.id, botId, at, "finish", newLevel,
      JSON.stringify(played != null ? { playedMinutes: played, source } : { source }));
    changed.finished = true;
  }

  if (talents) {
    changed.talents = applyTalents(db, q, race, botId, talents, at);
  }

  const within = (xpNow != null && xpMax) ? Math.max(0, Math.min(xpNow, xpMax)) : state.xp;
  q.putState.run(race.id, botId, newLevel, within, state.step, state.deaths,
    state.alive, played != null ? played : state.played_minutes,
    changed.finished ? at : state.finished_at);
  if (played != null) q.setPlayedKnown.run(1, race.id, botId);

  return changed;
}

/**
 * Talents arrive as a flat {talentId: rank} map - that is what any source can
 * actually give us. Turn it into the route the rest of the code expects, in a
 * legal order, so a real character's build renders exactly like a bot's.
 */
function applyTalents(db, q, race, botId, ranks, at) {
  const row = q.listBots.all(race.id).find(b => b.id === botId);
  if (!row) return false;
  const trees = rules.classData(race.edition, row.klass).trees;

  const wanted = {};
  for (const tree of trees) {
    wanted[tree.id] = {};
    for (const tal of tree.talents) {
      const r = Number(ranks[tal.id] || ranks[tal.name] || 0);
      wanted[tree.id][tal.id] = Math.max(0, Math.min(r, tal.maxRank));
    }
  }

  // Walk it into a legal order: repeatedly take any talent still short of what
  // was reported and currently learnable. A build that cannot be reached is a
  // build the source got wrong, and saying so beats storing nonsense.
  const st = rules.emptyState(trees);
  const route = [];
  for (;;) {
    const next = rules.learnable(trees, st)
      .find(o => st[o.tree.id][o.tal.id] < wanted[o.tree.id][o.tal.id]);
    if (!next) break;
    st[next.tree.id][next.tal.id]++;
    route.push(rules.routeStep(next.tree, next.tal));
  }

  const asked = Object.values(wanted).reduce(
    (n, t) => n + Object.values(t).reduce((m, v) => m + v, 0), 0);
  const reachable = route.length;

  db.prepare("UPDATE bots SET route = ?, spec = ? WHERE race_id = ? AND id = ?")
    .run(JSON.stringify(route), routes.describe(trees, st), race.id, botId);
  db.prepare("UPDATE bot_state SET step = ? WHERE race_id = ? AND bot_id = ?")
    .run(reachable, race.id, botId);

  if (reachable !== asked) {
    q.addEvent.run(race.id, botId, at, "note", 0, JSON.stringify({
      warning: "reported talents are not a legal build",
      asked, reachable,
    }));
  }
  return true;
}

/* ---------------- reading it back ---------------- */

/** Everything a source has said about one character, oldest first. */
const history = (q, raceId, botId) => q.observationsFor.all(raceId, botId);

/** The most recent readings across a race, for showing provenance. */
const recent = (q, raceId, limit = 40) => q.recentObservations.all(raceId, limit);

/**
 * How stale a race's data is. An armory only updates on logout, so this is the
 * number that says whether a standing is worth believing.
 */
function staleness(q, raceId, nowISO) {
  const now = Date.parse(nowISO || new Date().toISOString());
  const rows = q.recentObservations.all(raceId, 500);
  const newest = {};
  for (const r of rows) if (!newest[r.bot_id]) newest[r.bot_id] = r;

  const ages = [];
  let future = 0;
  for (const r of Object.values(newest)) {
    const age = (now - Date.parse(r.observed_at)) / 60000;
    if (!Number.isFinite(age)) continue;
    // A reading dated ahead of the clock means a clock is wrong somewhere, and
    // is worth saying so rather than reporting a negative age.
    if (age < 0) { future++; ages.push(0); } else ages.push(age);
  }

  if (!ages.length) return { seen: 0, oldest: null, median: null, future: 0 };
  ages.sort((a, b) => a - b);
  return {
    seen: ages.length,
    oldest: Math.round(ages[ages.length - 1]),
    median: Math.round(ages[Math.floor(ages.length / 2)]),
    future,
  };
}

module.exports = {
  SOURCES, createRealRace, addCharacter, record,
  applyTalents, minutesInto, history, recent, staleness,
};
