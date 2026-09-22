"use strict";
/**
 * Builds a share code the talent calculator will accept, so clicking a bot on
 * the leaderboard opens its actual build in the actual page rather than in some
 * second-rate copy of the tree drawn here.
 *
 * This has to match encode() in src/template.html exactly: same talent order,
 * same trailing-zero trim, same fingerprint. sim/test.js checks the format and
 * a browser probe has confirmed the page decodes one back to the same build.
 */

const slug = k => k.toLowerCase().replace(/[^a-z]/g, "");

const sortedTalents = tree => tree.talents.slice().sort((a, b) => (a.pos < b.pos ? -1 : 1));

/** FNV-1a, matching the page and server.js. */
function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0).toString(36);
}

/** Covers what a code depends on: which talents, in which order, and how many ranks. */
function fingerprint(trees) {
  let s = "";
  for (const tree of trees) {
    s += tree.id + "|";
    for (const t of sortedTalents(tree)) s += t.id + ":" + t.maxRank + ";";
  }
  return hash32(s);
}

/** e.g. "forever:shaman-0500320....abc123" */
function encode(editionId, klass, trees, st) {
  let digits = "";
  for (const tree of trees) {
    for (const tal of sortedTalents(tree)) digits += st[tree.id][tal.id];
  }
  digits = digits.replace(/0+$/, "");
  return editionId + ":" + slug(klass) + (digits ? "-" + digits : "") + "." + fingerprint(trees);
}

module.exports = { slug, sortedTalents, hash32, fingerprint, encode };
