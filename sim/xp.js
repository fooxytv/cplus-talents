"use strict";
/**
 * The vanilla levelling curve, the real one.
 *
 *   xp(L) = round-to-nearest-100( (8 * L + Diff(L)) * (45 + 5 * L) )
 *
 * which reproduces every published value exactly - 400 at level 1, 7,600 at 10,
 * 23,200 at 20, 90,700 at 40, 209,800 at 59. sim/test.js checks twelve of them,
 * so a change here that breaks the curve fails loudly.
 *
 * Two things worth writing down, because both cost me a wrong answer first:
 *
 * - The published rest factor RF(L) does NOT apply to this table. Applying it
 *   puts level 20 at 20,900 against the real 23,200. It belongs to mob
 *   experience, not to the level requirement.
 * - Diff(L) is not triangular. It is 0 up to 28, then 1, 3, 6, and from level
 *   32 onward simply 5 * (L - 30).
 *
 * The previous version of this file used (8 * L) * (45 + 5 * L) with a fudge
 * constant, which had the right shape and the wrong totals - about 2.3x the
 * real thing at the top end, so the late levels dragged far more than they
 * should have.
 */

const MAX_LEVEL = 60;

/** The extra difficulty term. Flat until 28, then it climbs linearly. */
function diff(level) {
  if (level <= 28) return 0;
  if (level === 29) return 1;
  if (level === 30) return 3;
  if (level === 31) return 6;
  return 5 * (level - 30);
}

/** Base experience a same-level mob is worth in the old world. */
const mobXp = level => 45 + 5 * level;

/** XP needed to get from `level` to `level + 1`. */
function toNext(level) {
  if (level < 1 || level >= MAX_LEVEL) return Infinity;
  return Math.round(((8 * level) + diff(level)) * mobXp(level) / 100) * 100;
}

/** Total XP from level 1 to `level`. */
function totalTo(level) {
  let n = 0;
  for (let l = 1; l < level; l++) n += toNext(l);
  return n;
}

module.exports = { MAX_LEVEL, diff, toNext, totalTo, mobXp };
