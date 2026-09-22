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
function roll(klass, rng, taken) {
  const races = racesFor(klass);
  if (!races.length) {
    throw new Error(`no race in config/roster.json can be a ${klass}`);
  }
  const race = rng.pick(races);
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

const classIcon = klass => "classicon_" + klass.toLowerCase().replace(/[^a-z]/g, "");

module.exports = { CONFIG, racesFor, roll, classIcon, GENDERS };
