#!/usr/bin/env node
"use strict";
/**
 * node test/picker-library-tests.js
 *
 * Guards src/picker-library.json - everything the edit-mode picker offers
 * beyond library.json: the Forever and Cataclysm trees this app ships, and the
 * spellbooks' class abilities.
 *
 * The rule that matters: a spell is NOT a talent. Talents are capped at
 * MAX_RANK ranks and every rank must carry text, and validate.js rejects a
 * whole dataset that breaks either. The spellbooks break both - Lightning Bolt
 * has ten ranks, Mutilate rank 1 has no text - so if the builder ever stops
 * reshaping them, editing a tree would produce a dataset the server refuses to
 * save, and the failure would land at save time rather than here.
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
let passed = 0;
const failures = [];
const ok = (name, cond) => { if (cond) passed++; else failures.push(name); };

const { validateDataset, MAX_RANK } = require(path.join(ROOT, "src", "validate.js"));

const LIB = path.join(ROOT, "src", "picker-library.json");
if (!fs.existsSync(LIB)) {
  console.log("  picker-library.json is missing - run: node tools/build-picker-library.js");
  process.exit(1);
}
const { talents, spells } = JSON.parse(fs.readFileSync(LIB, "utf8"));
const all = talents.concat(spells);

/* ---------------- shape ---------------- */

ok("the library has talents in it", Array.isArray(talents) && talents.length > 500);
ok("the library has spells in it", Array.isArray(spells) && spells.length > 100);

ok("every entry has what the picker needs to draw it",
   all.every(e => e.key && e.name && e.icon && e.klass && e.source));

ok("every entry is labelled talent or spell",
   talents.every(t => t.kind === "talent") && spells.every(s => s.kind === "spell"));

ok("keys are unique", new Set(all.map(e => e.key)).size === all.length);

ok("spells carry the level they are learned at",
   spells.every(s => Number.isFinite(s.level)));

/* ---------------- the talent rules ---------------- */

ok(`nothing exceeds ${MAX_RANK} ranks`,
   all.every(e => Number.isInteger(e.maxRank) && e.maxRank >= 1 && e.maxRank <= MAX_RANK));

ok("the rank count matches the descriptions",
   all.every(e => Array.isArray(e.ranks) && e.ranks.length === e.maxRank));

ok("every rank carries text",
   all.every(e => e.ranks.every(r => typeof r === "string" && r.trim())));

/*
 * The real test: take each entry, put it in a tree the way insertTalent does,
 * and run it through validateDataset - the same function server.js calls
 * before it writes an edited dataset. Anything that fails here would instead
 * fail at save time, after the editing work had been done.
 *
 * Every entry, not a sample: the ones that break this are the rare shapes.
 */
ok("every entry inserted as a talent passes the dataset validator", (() => {
  const asTree = (e, id) => ({
    id: id, name: id, icon: "x",
    talents: [{
      id: "probe", name: e.name, pos: "a1", icon: e.icon,
      maxRank: e.maxRank, reqPoints: 0, ranks: e.ranks.slice(),
    }],
  });
  const bad = [];
  for (const e of all) {
    const problems = validateDataset({
      [e.klass]: { trees: [asTree(e, "t1"), asTree(e, "t2"), asTree(e, "t3")] },
    });
    if (problems.length) bad.push(e.name + ": " + problems[0]);
  }
  if (bad.length) {
    failures.push("  " + bad.length + " of " + all.length + " would be refused on save");
    bad.slice(0, 5).forEach(b => failures.push("    " + b));
  }
  return bad.length === 0;
})());

/* ---------------- which sources are here ---------------- */

const sources = new Set(all.map(e => e.source));
const talentSources = new Set(talents.map(e => e.source));
const spellSources = new Set(spells.map(e => e.source));

ok("Forever's talents are in the picker",
   talents.some(t => t.source === "Forever"));
ok("Cataclysm's talents are in the picker",
   talents.some(t => t.source === "Cataclysm"));

/*
 * library.json already carries Wowhead's Classic / TBC / Wrath talents. If the
 * shipped editions of the same name were added here too, every vanilla talent
 * would appear twice in the picker.
 */
for (const dupe of ["Vanilla", "Classic", "WotLK", "Wrath"]) {
  ok(`"${dupe}" talents are not duplicated out of library.json`, !talentSources.has(dupe));
}

/*
 * SPELLS of the same name are a different matter, and wanted: library.json
 * carries no abilities at all, so a Classic or Wrath spellbook adds rather
 * than repeats. They are named to match the talents' expansion exactly, so the
 * picker's one filter covers both halves of an era.
 */
for (const book of ["Classic", "TBC", "WotLK", "Cataclysm", "Forever"]) {
  ok(`the ${book} spellbook is in the picker`, spellSources.has(book));
}
ok("no spellbook uses a second name for an era library.json already names",
   !spellSources.has("Vanilla") && !spellSources.has("Wrath"));

ok("Classic+ is not baked in - it is the one set that can be edited",
   !sources.has("Classic+"));

/* ---------------- known content ---------------- */

// The ability this feature was asked for, by name.
const lavaSpell = spells.find(s => s.name === "Lava Burst");
ok("Lava Burst is pickable as a spell", !!lavaSpell);
ok("Lava Burst is a Shaman ability", lavaSpell && lavaSpell.klass === "Shaman");
ok("Lava Burst keeps its own ranks", lavaSpell && lavaSpell.maxRank === 3);

// Forever has it as a talent too, which is the one-rank version.
const lavaTalent = talents.find(t => t.name === "Lava Burst" && t.source === "Forever");
ok("Forever's own Lava Burst talent is there", !!lavaTalent);
ok("and it is the single-rank one", lavaTalent && lavaTalent.maxRank === 1);

/*
 * A ten-rank ladder is the case that would break a save. The source has to be
 * pinned now that Classic has a Lightning Bolt of its own - vanilla's numbers
 * against Forever's spell-power scaling - or this compares one book's ranks
 * with the other's text.
 */
const bolt = spells.find(s =>
  s.name === "Lightning Bolt" && s.klass === "Shaman" && s.source === "Forever");
ok("Lightning Bolt survives the rank ceiling", !!bolt && bolt.maxRank === MAX_RANK);
ok("and it records how many ranks it really had", !!bolt && bolt.fullRanks === 10);
ok("the thinned ranks keep the weakest and the strongest", (() => {
  if (!bolt) return false;
  const book = JSON.parse(fs.readFileSync(
    path.join(ROOT, "src", "spellbooks", "forever.json"), "utf8"));
  const rows = book.classes.Shaman
    .filter(e => e.name === "Lightning Bolt")
    .sort((a, b) => a.level - b.level);
  return bolt.ranks[0] === rows[0].desc.trim() &&
         bolt.ranks[bolt.ranks.length - 1] === rows[rows.length - 1].desc.trim();
})());

// Mutilate rank 1 ships with no tooltip text at all.
const mutilate = spells.find(s => s.name === "Mutilate");
ok("a blank rank borrows text rather than shipping empty",
   !!mutilate && mutilate.ranks.every(r => r.trim().length > 10));

ok("every class in the book is represented",
   new Set(spells.map(s => s.klass)).size >= 9);
ok("the Forever talents cover every class",
   new Set(talents.filter(t => t.source === "Forever").map(t => t.klass)).size >= 9);

/* ---------------- the expansion spellbooks ---------------- */

// The ability this second round was asked for, by name. Forever stops at 60,
// so a level-70 spell could only come from the TBC book.
const bloodlust = spells.find(s => s.name === "Bloodlust");
ok("Bloodlust is pickable", !!bloodlust);
ok("Bloodlust is TBC's, at 70",
   !!bloodlust && bloodlust.source === "TBC" && bloodlust.level === 70);
ok("Bloodlust carries its real tooltip",
   !!bloodlust && /30%/.test(bloodlust.ranks[0]));

for (const [name, book, level] of [
  ["Heroism", "TBC", 70],
  ["Death Grip", "WotLK", 55],
  ["Time Warp", "Cataclysm", 85],
  ["Colossus Smash", "Cataclysm", 81],
]) {
  const hit = spells.find(s => s.name === name && s.source === book);
  ok(`${name} is in the ${book} book at ${level}`, !!hit && hit.level === level);
}

/*
 * The whole point of resolving each id against its own expansion rather than
 * copying Forever's text: vanilla states flat damage, Classic+ scales off
 * spell power. Same spell, same id, two different books.
 */
const vanillaBolt = spells.find(s =>
  s.name === "Lightning Bolt" && s.klass === "Shaman" && s.source === "Classic");
ok("Classic has its own Lightning Bolt", !!vanillaBolt);
ok("and it reads as vanilla, not as Classic+",
   !!vanillaBolt && !/Spell Power/i.test(vanillaBolt.ranks[0]) &&
   !!bolt && /Spell Power/i.test(bolt.ranks[0]));

/*
 * A spell a talent grants has no trainer level, so it lands at 1. The trees
 * are already in the picker out of library.json, so one here would be the
 * same ability twice - once with a meaningless "learned at 1".
 */
ok("no expansion book lists a talent-granted spell at level 1",
   spells.filter(s => ["TBC", "WotLK", "Cataclysm"].includes(s.source))
         .every(s => s.level > 1));

ok("Death Knight abilities exist only from Wrath on", (() => {
  const dk = spells.filter(s => s.klass === "Death Knight");
  return dk.length > 0 && dk.every(s => s.source === "WotLK" || s.source === "Cataclysm");
})());

ok("every spell names the book it came from",
   spells.every(s => s.source && s.expansion === s.source));

console.log(`\n  ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log("    FAIL  " + f);
  process.exit(1);
}
