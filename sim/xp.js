"use strict";
/**
 * The levelling curve.
 *
 * Shape comes from the vanilla formula:  xp(L) = (8 * L) * (45 + 5 * L)
 * which gives the known 400 xp for level 1 -> 2 and climbs the way the real
 * game does. What it does NOT include are the level-28+ adjustments (the "D"
 * and "RF" terms), so the raw total for 1 -> 60 comes out roughly twice the
 * real one.
 *
 * Rather than guess at constants I am not sure of, the model is calibrated at
 * the other end: SCALE is set so an average bot finishes in a believable number
 * of hours played. The shape is right, the absolute numbers are a dial. If the
 * exact per-level table matters later, drop it in here and set SCALE to 1 -
 * nothing else in the sim looks at these numbers directly.
 */

// Tuned so a mid-field bot lands near TARGET_HOURS in engine.js.
const SCALE = 0.5;

const MAX_LEVEL = 60;

/** XP needed to get from `level` to `level + 1`. */
function toNext(level) {
  if (level < 1 || level >= MAX_LEVEL) return Infinity;
  return Math.round(8 * level * (45 + 5 * level) * SCALE);
}

/** Total XP from level 1 to `level`. */
function totalTo(level) {
  let n = 0;
  for (let l = 1; l < level; l++) n += toNext(l);
  return n;
}

/**
 * Base XP a mob of the player's level is worth. Kills per level rises far more
 * slowly than XP required, which is what makes the later levels feel like a
 * wall - and why a build that kills faster compounds.
 */
const mobXp = level => 45 + 5 * level;

module.exports = { MAX_LEVEL, SCALE, toNext, totalTo, mobXp };
