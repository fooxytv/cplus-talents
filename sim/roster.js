"use strict";
/**
 * Who a bot is: faction, race, gender and a name that suits them.
 *
 * All of it comes out of config/roster.json rather than being written into the
 * code, because the one thing that is certainly going to change is the
 * class/race table - Forever is not obliged to keep vanilla's.
 */

const fs = require("fs");
const path = require("path");

const CONFIG = JSON.parse(
  fs.readFileSync(path.join(__dirname, "config", "roster.json"), "utf8"));

const GENDERS = ["male", "female"];

/** Races that may be this class at all. */
function racesFor(klass) {
  return Object.entries(CONFIG.races)
    .filter(([, r]) => r.classes.includes(klass))
    .map(([name, r]) => ({ name, ...r }));
}

/**
 * Roll a character. Races are picked evenly rather than weighted, so a field of
 * thirty Shamans lands roughly a third each of Orc, Tauren and Troll instead of
 * being all one thing.
 */
function roll(klass, rng, taken, forceRace) {
  const races = racesFor(klass);
  if (!races.length) {
    throw new Error(`no race in config/roster.json can be a ${klass}`);
  }
  const race = forceRace
    ? { name: forceRace, ...CONFIG.races[forceRace] }
    : rng.pick(races);
  const gender = rng.pick(GENDERS);
  const faction = CONFIG.factions[race.faction];

  let name = null;
  for (let i = 0; i < 300 && !name; i++) {
    const n = rng.pick(race.head) + rng.pick(race.tail);
    if (!taken.has(n)) { taken.add(n); name = n; }
  }
  if (!name) { name = "Bot" + (taken.size + 1); taken.add(name); }

  return {
    name,
    race: race.name,
    faction: race.faction,
    gender,
    raceIcon: race.icon + "_" + gender,
    factionIcon: faction ? faction.icon : null,
    factionColour: faction ? faction.colour : "#8b8579",
  };
}

/**
 * Every legal (race, class) pair for the classes on offer. Rolling from this
 * flat list rather than picking a class and then a race keeps both factions in
 * the field: Alliance simply has more races able to take most classes.
 */
function pairs(classes) {
  const out = [];
  for (const [name, r] of Object.entries(CONFIG.races)) {
    for (const klass of r.classes) {
      if (classes.includes(klass)) out.push({ race: name, klass, ...r });
    }
  }
  return out;
}

/** Roll a whole character from a list of classes rather than one fixed class. */
function rollAny(classes, rng, taken) {
  const all = pairs(classes);
  if (!all.length) {
    throw new Error(`no race in config/roster.json can be any of: ${classes.join(", ")}`);
  }
  const pick = rng.pick(all);
  const who = roll(pick.klass, rng, taken, pick.race);
  return { ...who, klass: pick.klass };
}

const classIcon = klass => "classicon_" + klass.toLowerCase().replace(/[^a-z]/g, "");

module.exports = { CONFIG, racesFor, pairs, roll, rollAny, classIcon, GENDERS };
