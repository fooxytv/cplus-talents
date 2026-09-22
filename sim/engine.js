"use strict";
/**
 * The tick.
 *
 * Everything here is deliberately a dial, gathered at the top, because the
 * interesting question is not "does it run" but "is it worth watching". A model
 * with too little variance produces a procession in build order; too much and
 * the build stops mattering and it is just dice. The defaults below are a first
 * guess at the middle.
 */

const rules = require("./rules");
const stats = require("./stats");
const xp = require("./xp");

const TICK_MINUTES = 10;

const TUNING = {
  // a character with no talents at all, grinding flat out
  baseKillsPerHour: 62,
  // fraction of time spent eating, drinking, walking back
  baseDowntime: 0.40,

  // how hard each stat pulls. power and sustain are the throughput pair;
  // raising these makes the build matter more and luck matter less
  powerK: 0.85,
  sustainK: 2.5,
  defenseK: 1.4,
  aoeK: 0.55,

  // luck, per tick. 0.14 keeps a good build ahead of a lucky bad one over
  // sixty levels, while still letting a single evening go badly
  variance: 0.14,

  // deaths per hour for a reckless character with no defensive talents
  baseDeathsPerHour: 0.10,
  // minutes lost to a corpse run, repair and the walk back
  deathCostMinutes: 14,

  // Hardcore is not the same event with a harsher penalty - it is played
  // differently. This counts only the mistakes that actually end a character,
  // and is set so roughly a quarter of a careful field reaches 60. Raise it
  // and hardcore becomes a massacre; lower it and it stops being hardcore.
  //
  // It is tied to how long a run lasts, so it had to come down when the xp
  // curve was corrected: the real climb is about 2.4x the one this was first
  // calibrated against, and at the old rate nobody survived it.
  hardcoreDeathScale: 0.055,
  // the first twenty levels are forgiving; the danger is later
  safeUntilLevel: 20,

  // recklessness trades safety for speed, and is the main reason two identical
  // builds finish at different times
  recklessSpeed: 0.35,
  recklessDanger: 2.5,
};

/* ---------------- a bot ---------------- */

function newBot({ id, name, klass, editionId, route, bias, rng }) {
  const { trees } = rules.classData(editionId, klass);
  return {
    id, name, klass, editionId, route, bias,
    trees,
    level: 1,
    xp: 0,
    step: 0,                 // talent points spent
    deaths: 0,
    alive: true,
    finishedAt: null,
    playedMinutes: 0,
    // personality
    recklessness: bias.recklessness,
    hoursPerDay: bias.hoursPerDay,
    startHour: bias.startHour,
    rng,
  };
}

/** Is this bot at the keyboard at this point in the race? */
function online(bot, minutesElapsed) {
  const hour = (minutesElapsed / 60) % 24;
  const since = (hour - bot.startHour + 24) % 24;
  return since < bot.hoursPerDay;
}

/** Current derived stats, from the points actually spent so far. */
function currentStats(bot) {
  return stats.statsAtStep(bot.klass, bot.trees, bot.route, bot.step);
}

/** XP per hour, before luck. */
function xpPerHour(bot, s) {
  const kills = TUNING.baseKillsPerHour
    * (1 + s.power * TUNING.powerK)
    * (1 + s.aoe * TUNING.aoeK)
    * (1 + bot.recklessness * TUNING.recklessSpeed);

  const downtime = TUNING.baseDowntime / (1 + s.sustain * TUNING.sustainK);
  return kills * (1 - downtime) * xp.mobXp(bot.level);
}

/** Chance of dying during one tick. */
function deathChance(bot, s, opts = {}) {
  const ramp = Math.min(1, bot.level / TUNING.safeUntilLevel);
  const perHour = TUNING.baseDeathsPerHour
    * (opts.hardcore ? TUNING.hardcoreDeathScale : 1)
    * ramp
    * (0.3 + bot.recklessness * TUNING.recklessDanger)
    / (1 + s.defense * TUNING.defenseK);
  return perHour * (TICK_MINUTES / 60);
}

/**
 * Advance one bot by one tick. Returns the events that happened, which are the
 * only thing the caller should persist - the bot object is a cache of them.
 */
function tick(bot, minutesElapsed, opts = {}) {
  const events = [];
  if (!bot.alive || bot.finishedAt !== null) return events;
  if (!online(bot, minutesElapsed)) return events;

  const s = currentStats(bot);
  let minutes = TICK_MINUTES;

  // did it go wrong?
  if (bot.rng() < deathChance(bot, s, opts)) {
    bot.deaths++;
    if (opts.hardcore) {
      bot.alive = false;
      events.push({ type: "death", level: bot.level, fatal: true });
      return events;
    }
    minutes = Math.max(0, minutes - TUNING.deathCostMinutes);
    events.push({ type: "death", level: bot.level, fatal: false });
  }

  bot.playedMinutes += TICK_MINUTES;

  const luck = Math.max(0.15, bot.rng.normal(1, TUNING.variance));
  bot.xp += xpPerHour(bot, s) * (minutes / 60) * luck;

  // level ups - more than one in a tick is possible at low level
  for (;;) {
    const need = xp.toNext(bot.level);
    if (bot.xp < need) break;
    bot.xp -= need;
    bot.level++;
    events.push({ type: "ding", level: bot.level, played: bot.playedMinutes });

    if (bot.level >= rules.FIRST_POINT_LEVEL && bot.step < bot.route.length) {
      const step = bot.route[bot.step++];
      events.push({ type: "talent", level: bot.level, tree: step.tree, talent: step.talent });
    }
    if (bot.level >= xp.MAX_LEVEL) {
      bot.finishedAt = minutesElapsed;
      bot.xp = 0;
      events.push({ type: "finish", level: bot.level, playedMinutes: bot.playedMinutes });
      break;
    }
  }
  return events;
}

module.exports = { TICK_MINUTES, TUNING, newBot, online, currentStats, xpPerHour, deathChance, tick };
