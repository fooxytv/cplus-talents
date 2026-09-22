"use strict";
/**
 * A small seeded PRNG. Not for anything that needs to be unguessable - it is
 * here so a race can be re-run and debugged, and so the same bot makes the same
 * choices twice when you are trying to work out why it lost.
 *
 * The database, not this, is the record of what happened. Re-running a race
 * after tuning the model gives different results, and should.
 */

// mulberry32
function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  next.int = n => Math.floor(next() * n);
  next.pick = arr => arr[next.int(arr.length)];
  next.range = (lo, hi) => lo + next() * (hi - lo);
  // Box-Muller, clamped - used for "how well did this hour go"
  next.normal = (mean, sd, clamp = 3) => {
    const u = Math.max(next(), 1e-9), v = next();
    let z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    if (z > clamp) z = clamp;
    if (z < -clamp) z = -clamp;
    return mean + z * sd;
  };
  // pick an index from a list of non-negative weights
  next.weighted = weights => {
    let total = 0;
    for (const w of weights) total += Math.max(0, w);
    if (total <= 0) return next.int(weights.length);
    let r = next() * total;
    for (let i = 0; i < weights.length; i++) {
      r -= Math.max(0, weights[i]);
      if (r <= 0) return i;
    }
    return weights.length - 1;
  };
  return next;
}

// Turn a string into a seed, so a bot's name alone reproduces its behaviour.
function seedFrom(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

module.exports = { rng, seedFrom };
