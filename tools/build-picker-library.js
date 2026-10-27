#!/usr/bin/env node
/**
 * Builds src/picker-library.json - everything the edit-mode picker can offer
 * BEYOND library.json, which holds only Wowhead's Classic / TBC / Wrath
 * talents.
 *
 *   node tools/build-picker-library.js
 *
 * Two sources, both already on disk, so this needs no network:
 *
 *   talents  from src/editions/*.json - the trees this app ships. Forever and
 *            Cataclysm are here and were missing from the picker entirely.
 *   spells   from src/spellbooks/*.json - class abilities, so Lava Burst can
 *            be made a talent without typing its tooltip out by hand.
 *
 * Both are read whatever is present rather than from a fixed list, so building
 * another spellbook adds its spells on the next run with no change here.
 *
 * Two things the spellbooks do that talents cannot:
 *
 *   1. Ranks. A spell's ranks are separate rows (Lightning Bolt is ten of
 *      them). A talent may have at most MAX_RANK, and validate.js rejects a
 *      dataset that breaks that, so a longer ladder is thinned to five evenly
 *      spaced rungs - always keeping the first and the last, so the weakest
 *      and strongest text survive and the progression still reads correctly.
 *   2. Blank text. validate.js also insists every rank has description text,
 *      and a few rows have none (Mutilate rank 1). A blank borrows from the
 *      nearest rank that has text; a spell with no text at all is dropped
 *      rather than shipped as something that cannot be saved.
 */
const fs = require("fs");
const path = require("path");
const { MAX_RANK } = require("../src/validate.js");

const ROOT = path.join(__dirname, "..");
const BOOKS_DIR = path.join(ROOT, "src", "spellbooks");
const EDITION_DIR = path.join(ROOT, "src", "editions");
const OUT = path.join(ROOT, "src", "picker-library.json");

/*
 * Editions whose talents library.json already carries, under its own names:
 * Vanilla is its "Classic", Wrath its "WotLK". Listing them here as well would
 * show every vanilla talent twice, which is worse than not having them.
 *
 * Classic+ (src/talents.json) is left out for a different reason: it is the
 * one set that can be EDITED, so a copy baked in here would go stale the first
 * time someone saved a change.
 */
const ALREADY_IN_LIBRARY = new Set(["classic", "tbc", "wotlk"]);

/** "Rank 10" -> 10. Rows without one sort before the ranked ones. */
function rankNumber(entry) {
  const m = /(\d+)/.exec(String(entry.rank || ""));
  return m ? Number(m[1]) : 0;
}

/**
 * Pick `want` items spread across `list`, always including the ends. For ten
 * ranks and a ceiling of five that gives ranks 1, 3, 6, 8 and 10 - the shape of
 * the ladder, not just its bottom.
 */
function spread(list, want) {
  if (list.length <= want) return list.slice();
  const out = [];
  for (let i = 0; i < want; i++) {
    out.push(list[Math.round((i * (list.length - 1)) / (want - 1))]);
  }
  return out;
}

/** The nearest rank with text, looking forward first, then back. */
function borrowDesc(rows, i) {
  for (let j = i + 1; j < rows.length; j++) {
    const d = String(rows[j].desc || "").trim();
    if (d) return d;
  }
  for (let j = i - 1; j >= 0; j--) {
    const d = String(rows[j].desc || "").trim();
    if (d) return d;
  }
  return "";
}

const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function readDir(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith(".json")).sort();
}

/* ---------------- talents, from the shipped editions ---------------- */

function buildTalents(report) {
  const out = [];
  for (const file of readDir(EDITION_DIR)) {
    const id = path.basename(file, ".json");
    if (ALREADY_IN_LIBRARY.has(id)) { report.push({ source: id, skipped: true }); continue; }

    const ed = JSON.parse(fs.readFileSync(path.join(EDITION_DIR, file), "utf8"));
    const source = ed.name || id;
    let kept = 0;

    for (const [klass, cls] of Object.entries(ed.classes || {})) {
      for (const tree of cls.trees || []) {
        for (const t of tree.talents || []) {
          if (!t || !t.name || !Array.isArray(t.ranks) || !t.ranks.length) continue;
          const ranks = t.ranks.map(r => String(r == null ? "" : r).trim());
          if (ranks.some(r => !r)) continue;        // validate.js would refuse it
          out.push({
            key: "ed:" + slug(source) + ":" + slug(klass) + ":" + slug(tree.name) + ":" + slug(t.name),
            kind: "talent",
            source: source,
            expansion: source,
            klass: klass,
            tree: tree.name,
            name: t.name,
            icon: t.icon || "inv_misc_questionmark",
            maxRank: Math.min(ranks.length, MAX_RANK),
            ranks: ranks.slice(0, MAX_RANK),
            reqPoints: Number.isInteger(t.reqPoints) ? t.reqPoints : 0,
          });
          kept++;
        }
      }
    }
    report.push({ source, kept });
  }
  return out;
}

/* ---------------- spells, from the spellbooks ---------------- */

function buildSpells(report) {
  const out = [];
  for (const file of readDir(BOOKS_DIR)) {
    const book = JSON.parse(fs.readFileSync(path.join(BOOKS_DIR, file), "utf8"));
    const source = book.name || book.id || path.basename(file, ".json");
    let kept = 0, trimmed = 0, dropped = 0, patched = 0;

    for (const [klass, list] of Object.entries(book.classes || {})) {
      const byName = new Map();
      for (const e of list) {
        if (!e || !e.name) continue;
        if (!byName.has(e.name)) byName.set(e.name, []);
        byName.get(e.name).push(e);
      }

      for (const [name, rowsRaw] of byName) {
        // Lowest rank first: level is the real order, rank number breaks ties.
        const rows = rowsRaw.slice().sort((a, b) =>
          (a.level - b.level) || (rankNumber(a) - rankNumber(b)));

        if (!rows.some(r => String(r.desc || "").trim())) { dropped++; continue; }

        const chosen = spread(rows, MAX_RANK);
        if (rows.length > MAX_RANK) trimmed++;

        const ranks = chosen.map((r, i) => {
          const d = String(r.desc || "").trim();
          if (d) return d;
          patched++;
          return borrowDesc(chosen, i);
        });
        if (ranks.some(d => !d)) { dropped++; continue; }

        const first = chosen[0];
        out.push({
          key: "spell:" + slug(source) + ":" + slug(klass) + ":" + slug(name),
          kind: "spell",
          source: source,
          expansion: source,          // the picker filters on this, as for talents
          klass: klass,
          tree: "Spellbook",
          name: name,
          icon: first.icon || "inv_misc_questionmark",
          level: first.level || 1,
          maxRank: ranks.length,
          ranks: ranks,
          // what it looked like before the ceiling, so the UI can say so
          fullRanks: rows.length,
          spellId: first.id || null,
        });
        kept++;
      }
    }
    report.push({ source: source + " spells", kept, trimmed, dropped, patched });
  }
  return out;
}

function build() {
  const report = [];
  const talents = buildTalents(report);
  const spells = buildSpells(report);

  if (!talents.length && !spells.length) {
    console.error("nothing to build - no editions and no spellbooks found");
    process.exit(1);
  }

  const by = (a, b) => a.klass.localeCompare(b.klass) || a.name.localeCompare(b.name);
  talents.sort(by);
  spells.sort(by);

  fs.writeFileSync(OUT, JSON.stringify({
    generated: new Date().toISOString(),
    note: "Built by tools/build-picker-library.js from src/editions/*.json and " +
          "src/spellbooks/*.json. Ranks are capped at " + MAX_RANK +
          " because validate.js rejects more.",
    talents: talents,
    spells: spells,
  }));

  const kb = Math.round(fs.statSync(OUT).size / 1024);
  console.log("picker-library.json  " + kb + "KB  (" +
    talents.length + " talents, " + spells.length + " spells)");
  for (const r of report) {
    if (r.skipped) {
      console.log("  " + r.source.padEnd(17) + "skipped - library.json already has it");
      continue;
    }
    console.log("  " + r.source.padEnd(17) + r.kept + " kept" +
      (r.trimmed ? ", " + r.trimmed + " thinned to " + MAX_RANK + " ranks" : "") +
      (r.patched ? ", " + r.patched + " blank ranks filled" : "") +
      (r.dropped ? ", " + r.dropped + " dropped with no text" : ""));
  }

  const books = new Set(spells.map(s => s.source));
  const missing = ["Classic", "TBC", "WotLK", "Cataclysm"].filter(n => !books.has(n));
  if (missing.length) {
    console.log("\n  no spellbook yet for: " + missing.join(", "));
    console.log("  build one with: node tools/build-spellbook-ids.js <classic|tbc|wotlk|cata>");
  }
}

build();
