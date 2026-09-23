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

const SOD = { from: 390000, to: 500000 };
const inBand = all.filter(e => e.id >= SOD.from && e.id < SOD.to);

ok("no Season of Discovery runes are in the Forever spellbook", inBand.length === 0);

// Named so a failure says which ones came back rather than just a count.
if (inBand.length) {
  failures.push("  runes present: " +
    [...new Set(inBand.map(e => e.name))].slice(0, 8).join(", "));
}

/*
 * The three id bands have to stay separated, because cutting the middle one out
 * is only safe while nothing real lives in it. If Forever ever ships a spell in
 * that range this fails, and the rule needs looking at again rather than
 * quietly dropping content.
 */
const ids = all.map(e => e.id).sort((a, b) => a - b);
const vanilla = ids.filter(i => i < SOD.from);
const forever = ids.filter(i => i >= SOD.to);

ok("the vanilla band is still populated", vanilla.length > 1000);
ok("Forever's own spells are still there", forever.length > 50);
ok("there is a clear gap below the rune band",
   SOD.from - vanilla[vanilla.length - 1] > 100000);
ok("there is a clear gap above the rune band",
   forever[0] - SOD.to > 100000);

/* ---------------- known content ---------------- */

// Spells that 404 under the classic flavour, so they are Forever's own. If
// these vanish, the filter has gone too far.
const MUST_KEEP = ["Lava Burst", "Riptide", "Coup de Grace", "Frostfire Bolt"];
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

ok("every spell has what the page needs to draw it",
   all.every(e => e.id && e.name && e.icon && Number.isFinite(e.level)));

console.log(`\n  ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log("    FAIL  " + f);
  process.exit(1);
}
