#!/usr/bin/env node
"use strict";
/**
 * Clean a built spellbook: drop Season of Discovery runes, and collapse a
 * talent's ranks into one entry.
 *
 *   node tools/clean-spellbook.js            report what would change
 *   node tools/clean-spellbook.js --write    apply it
 *
 * Wowhead's Forever class pages carry SoD's runes, which are a vanilla Classic
 * thing and are not in Forever. build-spellbook.js now filters them, but this
 * fixes a spellbook that was built before it did, without needing a full
 * rebuild (which wants headless Chrome and several hundred tooltip fetches).
 *
 * The rule and the evidence for it live in tools/build-spellbook.js.
 */

const fs = require("fs");
const path = require("path");

/*
 * Season of Discovery's rune engravings leak into Wowhead's Forever class
 * pages. Identifying them took two goes, and the first was wrong in a way worth
 * recording.
 *
 * The id band is NOT enough on its own. Spell ids fall in three groups:
 *
 *        10 -    66,844   original vanilla
 *   398,196 -   469,145   SoD runes ... AND Forever's re-implemented spells
 * 1,221,404 - 1,316,995   Forever's own new spells
 *
 * The middle band holds both. Forever re-created a lot of core abilities with
 * new ids in the same range SoD used, so cutting the whole band out removed 98
 * genuine spells - Victory Rush at 20, and the full rank ladders for Renew,
 * Lightning Bolt, Fire Blast, Serpent Sting, Raptor Strike, Drain Life and
 * Exorcism.
 *
 * What actually separates them is the LEVEL. A rune is engraved, not learnt, so
 * it carries no level requirement and lands at level 1. A real ability has a
 * level and usually a rank ladder behind it. So:
 *
 *   in the band, at level 1, untrained  -> rune
 *   in the band, above level 1          -> a real Forever spell, keep it
 *
 * That splits the band 117 to 98, and every one of the 98 has a level and most
 * have ranks.
 */
const SOD_RUNES = { from: 390000, to: 500000 };
const isSodRune = e =>
  e.id >= SOD_RUNES.from && e.id < SOD_RUNES.to && e.level <= 1 && !e.trained;

const file = path.join(__dirname, "..", "src", "spellbooks", "forever.json");
const write = process.argv.includes("--write");

const book = JSON.parse(fs.readFileSync(file, "utf8"));
let removed = 0, kept = 0;
const samples = [];

for (const klass of Object.keys(book.classes)) {
  const before = book.classes[klass];
  const after = before.filter(e => {
    if (!isSodRune(e)) { kept++; return true; }
    removed++;
    if (samples.length < 12) samples.push(`${klass}: ${e.name} (${e.id}, level ${e.level})`);
    return false;
  });
  book.classes[klass] = after;
}

console.log(`${removed} rune engravings removed, ${kept} spells kept`);
console.log(samples.map(s => "  " + s).join("\n"));

/*
 * Wowhead also lists every RANK of a passive as its own row, so a spellbook
 * ends up with five identical-looking "Improved Battle Shout" lines at level 1.
 * Collapse them to the highest rank: the entry is still there, just once.
 *
 * This does NOT decide whether such a passive belongs in a spellbook at all.
 * Most are vanilla talents Forever reworked away - no trainer, no level, not in
 * Forever's trees - but a few, like Weaponmaster, ARE Forever talents. Telling
 * those apart is a judgement, not a rule, so this only fixes the duplication.
 */
/*
 * The same ability also appears twice at the same level, once under its
 * original id and once under a Forever re-implementation: Renew rank 1 is both
 * 139 (trained, costs 200c) and 425268 (untrained, no cost, different
 * coefficient). Keying on trained/untrained kept both, which is how a spellbook
 * ended up listing every Priest rank of Renew twice.
 *
 * A spellbook is what a trainer teaches you and when, so where the pair differ
 * the trained one wins. An ability with no trained twin - Victory Rush at 20 -
 * is untouched, because there is nothing to prefer it over.
 */
let collapsed = 0;
const collapsedSamples = [];
for (const klass of Object.keys(book.classes)) {
  const best = new Map();
  for (const e of book.classes[klass]) {
    const key = e.name + "@" + e.level;
    const rank = Number(String(e.rank || "").replace(/[^0-9]/g, "")) || 0;
    const seen = best.get(key);
    if (!seen) { best.set(key, { entry: e, rank }); continue; }

    collapsed++;
    if (collapsedSamples.length < 10) {
      collapsedSamples.push(`${klass}: ${e.name} (level ${e.level})`);
    }

    // trained beats untrained; failing that, the higher rank
    const better = (!!e.trained && !seen.entry.trained) ||
      (!!e.trained === !!seen.entry.trained && rank > seen.rank);
    if (better) best.set(key, { entry: e, rank });
  }
  book.classes[klass] = [...best.values()].map(v => v.entry)
    .sort((a, b) => a.level - b.level || a.name.localeCompare(b.name));
}
console.log(`\n${collapsed} duplicate ranks collapsed`);
console.log([...new Set(collapsedSamples)].map(x => "  " + x).join("\n"));

/*
 * Passive talent effects were also landing at level 1, because Wowhead lists a
 * talent's spell with no level requirement: "Improved Battle Shout Rank 5",
 * "Shield Specialization Rank 5", "Magic Attunement Rank 2".
 *
 * A spellbook is what you LEARN by levelling; a talent is something you choose,
 * and it is already drawn in the tree. Two signs give them away and neither
 * catches a real starting ability:
 *
 *   rank 2 or higher at level 1 - nobody starts with rank 5 of anything. The
 *                                 real ones are all Rank 1 or rankless.
 *   shares a name with a talent - catches the rankless ones, Weaponmaster and
 *                                 Hack and Slash, which really are Forever
 *                                 talents and so really do belong in the tree.
 *
 * What survives is exactly two abilities per class, which is what vanilla
 * actually gives you at level 1.
 */
const editionFile = path.join(__dirname, "..", "src", "editions", "forever.json");
const edition = JSON.parse(fs.readFileSync(editionFile, "utf8"));

let passives = 0;
const passiveSamples = [];
for (const klass of Object.keys(book.classes)) {
  const talentNames = new Set();
  const cls = edition.classes[klass];
  if (cls) for (const tree of cls.trees) for (const t of tree.talents) talentNames.add(t.name);

  book.classes[klass] = book.classes[klass].filter(e => {
    if (e.trained || e.level !== 1) return true;
    const rank = Number(String(e.rank || "").replace(/[^0-9]/g, "")) || 0;
    const isPassiveTalent = rank >= 2 || talentNames.has(e.name);
    if (!isPassiveTalent) return true;
    passives++;
    if (passiveSamples.length < 12) {
      passiveSamples.push(`${klass}: ${e.name}${e.rank ? " " + e.rank : ""}`);
    }
    return false;
  });
}
console.log("\n" + passives + " talent passives removed from level 1");
console.log(passiveSamples.map(x => "  " + x).join("\n"));

/*
 * The shared band is the interesting number now: what stays out of it is real
 * Forever content, and seeing that count go to zero would mean the level rule
 * has gone back to cutting the whole band out.
 */
const remaining = Object.values(book.classes).flat();
const ids = remaining.map(e => e.id).sort((a, b) => a - b);
const band = remaining.filter(e => e.id >= SOD_RUNES.from && e.id < SOD_RUNES.to);
console.log(`\nremaining id range: ${ids[0]} - ${ids[ids.length - 1]}`);
console.log(`kept from the shared band: ${band.length} real spells with levels`);
console.log(`still looking like a rune: ${remaining.filter(isSodRune).length}`);

if (!write) {
  console.log("\nnothing written - pass --write to apply");
  process.exit(0);
}

book.generated = new Date().toISOString();
book.note = "Season of Discovery runes removed (not in Forever); talent ranks collapsed to one entry each.";
fs.writeFileSync(file, JSON.stringify(book, null, 1) + "\n");
console.log(`\nwritten to ${path.relative(path.join(__dirname, ".."), file)}`);
