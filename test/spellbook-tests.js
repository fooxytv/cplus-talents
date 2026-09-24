#!/usr/bin/env node
"use strict";
/**
 * node test/spellbook-tests.js
 *
 * Guards the shipped spellbook data. The bug this exists for: Wowhead's Forever
 * class pages carry Season of Discovery's rune engravings, which are a vanilla
 * Classic feature and are not in Forever. They arrived in the spellbook as
 * level-1 "granted" abilities - Devastate, Molten Blast, Saber Slash - and sat
 * there on the live site.
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
let passed = 0;
const failures = [];
const ok = (name, cond) => { if (cond) passed++; else failures.push(name); };

const book = JSON.parse(
  fs.readFileSync(path.join(ROOT, "src", "spellbooks", "forever.json"), "utf8"));
const edition = JSON.parse(
  fs.readFileSync(path.join(ROOT, "src", "editions", "forever.json"), "utf8"));

const all = Object.values(book.classes).flat();

/* ---------------- the rune band ---------------- */
/*
 * The first version of this asserted that NOTHING may sit between 390,000 and
 * 500,000, which was wrong and shipped a regression: Forever re-implemented a
 * lot of core abilities with ids in exactly that range, so the rule removed 98
 * real spells - Victory Rush among them - and this file happily agreed.
 *
 * What identifies a rune is that it is engraved rather than learnt: no level
 * requirement, so it lands at level 1, and no trainer.
 */
const SOD = { from: 390000, to: 500000 };
const inBand = e => e.id >= SOD.from && e.id < SOD.to;
const looksLikeRune = e => inBand(e) && e.level <= 1 && !e.trained;

const runes = all.filter(looksLikeRune);
ok("no rune engravings are in the Forever spellbook", runes.length === 0);
if (runes.length) {
  failures.push("  present: " + [...new Set(runes.map(e => e.name))].slice(0, 8).join(", "));
}

// The other half of the same guard. If this ever reaches zero the band is being
// cut out wholesale again, which is the regression this file failed to catch.
const bandKept = all.filter(inBand);
ok("real Forever spells in the shared band are kept", bandKept.length > 10);
ok("and every one of them has a real level", bandKept.every(e => e.level > 1));

/* ---------------- known content ---------------- */

// Spells that 404 under the classic flavour, so they are Forever's own. If
// these vanish, the filter has gone too far.
// Victory Rush is the one a player noticed missing, so it leads the list.
const MUST_KEEP = [
  "Victory Rush", "Lava Burst", "Riptide", "Coup de Grace", "Frostfire Bolt",
  "Renew", "Lightning Bolt", "Serpent Sting", "Exorcism", "Drain Life",
];
for (const name of MUST_KEEP) {
  ok(`"${name}" is kept - it is Forever's own`, all.some(e => e.name === name));
}

// Runes that exist under classic too, so they are not Forever content.
const MUST_DROP = ["Molten Blast", "Saber Slash", "Balefire Bolt", "Shadowstrike"];
for (const name of MUST_DROP) {
  ok(`"${name}" is gone - it is a Season of Discovery rune`,
     !all.some(e => e.name === name));
}

// Mutilate is the reason a name-based filter would have been wrong: Season of
// Discovery has a rune of that name AND Forever has its own.
ok("Mutilate survives, because Forever has one of its own",
   all.some(e => e.name === "Mutilate"));

// Re-implemented spells sit alongside their originals at the same level, which
// listed every rank of Renew twice until the pair were collapsed.
ok("a re-implemented spell does not double up its original", (() => {
  for (const klass of Object.keys(book.classes)) {
    const seen = new Set();
    for (const e of book.classes[klass]) {
      const key = e.name + "@" + e.level;
      if (seen.has(key)) return false;
      seen.add(key);
    }
  }
  return true;
})());

ok("Renew has one entry per rank, not two", (() => {
  const renew = (book.classes.Priest || []).filter(e => e.name === "Renew");
  return renew.length >= 8 && renew.length <= 12;
})());

/* ---------------- shape ---------------- */

ok("every class has spells",
   Object.keys(edition.classes).every(k => (book.classes[k] || []).length > 50));

ok("no spell sits above the level cap",
   all.every(e => e.level >= 1 && e.level <= book.maxLevel));

ok("a talent's ranks are one entry, not five", (() => {
  for (const klass of Object.keys(book.classes)) {
    const seen = new Set();
    for (const e of book.classes[klass]) {
      const key = e.name + "@" + e.level + "@" + (e.trained ? "t" : "g");
      if (seen.has(key)) return false;
      seen.add(key);
    }
  }
  return true;
})());

/*
 * Level 1 is where the junk collected: SoD runes first, then passive talent
 * effects sitting at max rank. Vanilla gives a class two abilities at level 1,
 * so anything much past that means something has leaked in again.
 */
for (const klass of Object.keys(book.classes)) {
  const granted = book.classes[klass].filter(e => !e.trained && e.level === 1);
  ok(`${klass} starts with a believable number of abilities`, granted.length <= 3);
}

ok("nothing starts at rank 2 or higher", (() => {
  for (const klass of Object.keys(book.classes)) {
    for (const e of book.classes[klass]) {
      if (e.trained || e.level !== 1) continue;
      const rank = Number(String(e.rank || "").replace(/[^0-9]/g, "")) || 0;
      if (rank >= 2) return false;
    }
  }
  return true;
})());

// A talent belongs in the tree, which the page already draws. Finding one in
// the spellbook at level 1 means the passive filter has stopped working.
ok("no talent is listed as a level-1 ability", (() => {
  for (const klass of Object.keys(book.classes)) {
    const cls = edition.classes[klass];
    if (!cls) continue;
    const names = new Set();
    for (const tree of cls.trees) for (const t of tree.talents) names.add(t.name);
    for (const e of book.classes[klass]) {
      if (!e.trained && e.level === 1 && names.has(e.name)) return false;
    }
  }
  return true;
})());

ok("every spell has what the page needs to draw it",
   all.every(e => e.id && e.name && e.icon && Number.isFinite(e.level)));

console.log(`\n  ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log("    FAIL  " + f);
  process.exit(1);
}
