#!/usr/bin/env node
/**
 * Builds src/spellbooks/<id>.json for Vanilla, TBC, Wrath and Cataclysm from a
 * list of spell ids instead of a scraped class page.
 *
 *   node tools/build-spellbook-ids.js tbc
 *   node tools/build-spellbook-ids.js all
 *
 * Why a second spellbook builder exists
 * -------------------------------------
 * build-spellbook.js reads Wowhead's class page, which is the only place that
 * lists every ability a class learns. That page is HTML behind CloudFront and
 * is currently answering with a 944-byte "Request blocked", so Forever - built
 * back when the page still loaded - is the only book we have.
 *
 * The TOOLTIP endpoint is a different service and still answers:
 *
 *   https://nether.wowhead.com/tooltip/spell/<id>?dataEnv=<n>&locale=0
 *
 * and it is the good one. Given an id it returns that expansion's own name,
 * icon, description AND "Requires level N" - vanilla's Lightning Bolt comes
 * back as "15 to 17 Nature damage", not Classic+'s rebalanced wording. So the
 * only thing missing is the list of ids, and that is what this supplies.
 *
 * Where the ids come from, per book
 * ---------------------------------
 *   Vanilla   every pre-Forever id already in src/spellbooks/forever.json.
 *             Forever is a Classic+ server, so its book was scraped from a
 *             class list that is vanilla's plus Forever's own additions; the
 *             additions were given new ids in two high bands, so an id at or
 *             below VANILLA_MAX is an original vanilla spell. Each is then
 *             re-resolved at vanilla's dataEnv, so only the MEMBERSHIP comes
 *             from Forever - every word, level and icon is vanilla's.
 *
 *   the rest  tools/spell-ids/<id>.json, a hand-kept list of what that
 *             expansion ADDED, written as name -> id. Carried-forward spells
 *             are deliberately absent: their higher ranks have their own ids
 *             that only the class page could enumerate, and listing Lightning
 *             Bolt once per expansion would bury the picker in near-identical
 *             rows.
 *
 * The names in those files are expectations, not output. Each is checked
 * against what Wowhead returns and a disagreement is reported, so a mistyped
 * id shows up as a loud mismatch rather than a quietly wrong tooltip.
 *
 * Responses cache in tools/.cache under the same key build-edition.js uses, so
 * the two share their downloads and re-runs cost nothing.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const CACHE = path.join(__dirname, ".cache");
const IDS_DIR = path.join(__dirname, "spell-ids");
const OUT_DIR = path.join(ROOT, "src", "spellbooks");

/*
 * `name` has to match what library.json already calls the same expansion -
 * "Classic", not "Vanilla" - or the picker's expansion filter grows a second
 * entry for the same era and neither one holds everything.
 *
 * `from` is the lowest level the book should contain. It is a sanity check,
 * not a filter: a spell below it usually means the id belongs in an earlier
 * book. Death Knights start at 55, which is why Wrath's floor is not 71.
 */
const BOOKS = {
  classic: { name: "Classic",   slug: "classic", dataEnv: 4,  from: 1,  maxLevel: 60 },
  tbc:     { name: "TBC",       slug: "tbc",     dataEnv: 5,  from: 61, maxLevel: 70 },
  wotlk:   { name: "WotLK",     slug: "wotlk",   dataEnv: 8,  from: 55, maxLevel: 80 },
  cata:    { name: "Cataclysm", slug: "cata",    dataEnv: 11, from: 81, maxLevel: 85 },
};

/* The top of the original vanilla id range. See build-spellbook.js, which
 * works out the three id bands in detail and pays for having got it wrong. */
const VANILLA_MAX = 66844;

function clean(s) {
  return String(s == null ? "" : s)
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** The spell's own description is the last quoted block of the tooltip. */
function describe(html) {
  if (!html) return "";
  const blocks = [...String(html).matchAll(/<div class="q">([\s\S]*?)<\/div>/g)].map(m => m[1]);
  return clean(blocks.length ? blocks[blocks.length - 1] : "");
}

/** Trainer level, which the tooltip states outright. */
function levelOf(html) {
  const m = /Requires level (\d+)/i.exec(String(html || ""));
  return m ? Number(m[1]) : 0;
}

async function getJson(url, cacheKey) {
  const file = path.join(CACHE, cacheKey);
  if (fs.existsSync(file)) {
    try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { /* refetch */ }
  }
  const res = await fetch(url);
  const text = await res.text();
  if (!res.ok) throw new Error("HTTP " + res.status);
  const json = JSON.parse(text);
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(file, text);
  return json;
}

/** Resolves ids against one expansion, ten at a time. */
async function resolve(ids, dataEnv, label) {
  const out = new Map();
  const queue = ids.slice();
  const total = queue.length;
  let done = 0;

  const worker = async () => {
    while (queue.length) {
      const id = queue.shift();
      try {
        const j = await getJson(
          `https://nether.wowhead.com/tooltip/spell/${id}?dataEnv=${dataEnv}&locale=0`,
          `spell-${dataEnv}-${id}.json`);
        if (j && j.name) {
          out.set(id, {
            name: clean(j.name),
            icon: j.icon || "inv_misc_questionmark",
            desc: describe(j.tooltip),
            level: levelOf(j.tooltip),
          });
        }
      } catch (e) { /* an id with no spell behind it is reported as missing */ }
      done++;
      if (done % 100 === 0 || done === total) {
        process.stdout.write(`\r  ${label}: ${done}/${total} spells`);
      }
    }
  };
  await Promise.all(Array.from({ length: 10 }, worker));
  if (total) process.stdout.write("\n");
  return out;
}

/* ---------------- where each book's ids come from ---------------- */

/**
 * Vanilla: the pre-Forever ids out of Forever's own book, keeping the rank
 * label and whether a trainer taught it. Those two are Forever's reading of a
 * spell that vanilla also had, and the tooltip carries neither.
 */
function vanillaWants() {
  const file = path.join(OUT_DIR, "forever.json");
  if (!fs.existsSync(file)) {
    throw new Error("src/spellbooks/forever.json is missing - vanilla's id list is drawn from it");
  }
  const book = JSON.parse(fs.readFileSync(file, "utf8"));
  const wants = {};
  for (const [klass, list] of Object.entries(book.classes || {})) {
    wants[klass] = list
      .filter(e => e && e.id && e.id <= VANILLA_MAX)
      .map(e => ({ id: e.id, expect: e.name, rank: e.rank, trained: !!e.trained, level: e.level }));
  }
  return wants;
}

/** The others: a curated name -> id map per class. */
function curatedWants(key) {
  const file = path.join(IDS_DIR, key + ".json");
  if (!fs.existsSync(file)) throw new Error("no id list at tools/spell-ids/" + key + ".json");
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  const wants = {};
  for (const [klass, spells] of Object.entries(data.classes || {})) {
    wants[klass] = Object.entries(spells).map(([expect, id]) => ({ id, expect, trained: true }));
  }
  return wants;
}

/* ---------------- the build ---------------- */

async function buildBook(key) {
  const spec = BOOKS[key];
  if (!spec) throw new Error(`unknown book "${key}" - try ${Object.keys(BOOKS).join(", ")}`);
  console.log(spec.name + ":");

  const curated = key !== "classic";
  const wants = curated ? curatedWants(key) : vanillaWants();
  const ids = [...new Set(Object.values(wants).flat().map(w => w.id))];
  const got = await resolve(ids, spec.dataEnv, spec.name);

  const classes = {};
  const missing = [], renamed = [], outOfBand = [], noText = [], granted = [];
  let total = 0;

  for (const [klass, list] of Object.entries(wants)) {
    const rows = [];
    for (const want of list) {
      const hit = got.get(want.id);
      if (!hit) { missing.push(`${klass} ${want.expect} (${want.id})`); continue; }
      if (!hit.desc) { noText.push(`${klass} ${hit.name} (${want.id})`); continue; }
      if (want.expect && hit.name !== want.expect) {
        renamed.push(`${klass} ${want.id}: expected "${want.expect}", got "${hit.name}"`);
      }
      /*
       * No "Requires level" line means nothing teaches it at a level - it
       * comes from a talent. The talent trees are already in the picker out of
       * library.json, so listing it here as well would show it twice, once
       * with a meaningless "learned at 1". Vanilla is exempt: there a rank-1
       * spell really is available at level 1.
       */
      const level = hit.level || want.level || 0;
      if (!level && curated) { granted.push(`${klass} ${hit.name}`); continue; }
      if (level && (level < spec.from || level > spec.maxLevel)) {
        outOfBand.push(`${klass} ${hit.name} is level ${level}`);
      }

      const entry = { id: want.id, name: hit.name, level: level || 1, icon: hit.icon, desc: hit.desc };
      if (want.rank) entry.rank = want.rank;
      if (want.trained) entry.trained = true;
      rows.push(entry);
    }
    if (!rows.length) continue;
    rows.sort((a, b) => a.level - b.level ||
      (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) ||
      String(a.rank || "").localeCompare(String(b.rank || "")));
    classes[klass] = rows;
    total += rows.length;
  }

  const out = {
    id: key,
    name: spec.name,
    maxLevel: spec.maxLevel,
    /*
     * The spellbook VIEW shows a book as the class's whole kit. That is fair
     * for vanilla, which is every pre-Forever id there is, and badly wrong for
     * a book holding only what one expansion added, so it says which it is and
     * the view prints a line admitting the gap.
     */
    partial: curated,
    source: `https://nether.wowhead.com/tooltip/spell/<id>?dataEnv=${spec.dataEnv}`,
    generated: new Date().toISOString(),
    note: key === "classic"
      ? "Which spells each class has is taken from the pre-Forever ids in " +
        "forever.json; every name, level, icon and description is then read " +
        "from Wowhead's vanilla data."
      : "What this expansion ADDED, from tools/spell-ids/" + key + ".json. " +
        "Spells carried over from earlier expansions are not repeated here.",
    classes: classes,
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, key + ".json");
  fs.writeFileSync(file, JSON.stringify(out));

  console.log(`  src/spellbooks/${key}.json  ${(fs.statSync(file).size / 1024).toFixed(0)}KB  ` +
    `${Object.keys(classes).length} classes, ${total} abilities`);

  const report = (label, rows, cap) => {
    if (!rows.length) return;
    console.log(`  ${label}: ${rows.length}`);
    for (const r of rows.slice(0, cap)) console.log("    " + r);
    if (rows.length > cap) console.log(`    ... and ${rows.length - cap} more`);
  };
  /*
   * For a curated list a different name means the id is wrong. For vanilla it
   * usually means Forever renamed the spell - Curse of Agony became Bane of
   * Agony, as it later did in Cataclysm - and Wowhead's vanilla name, which is
   * what gets written out, is the right one.
   */
  report(curated ? "NAME MISMATCH - check the id"
                 : "named differently in vanilla (Forever's name on the left)", renamed, 20);
  report("dropped - a talent grants these, and the trees already carry them", granted, 20);
  report("level outside this expansion", outOfBand, 20);
  report("no spell at that id", missing, 10);
  report("no description, so dropped", noText, 10);
}

(async () => {
  const args = process.argv.slice(2);
  const wanted = !args.length || args[0] === "all" ? Object.keys(BOOKS) : args;
  for (const key of wanted) await buildBook(key);
})().catch(e => { console.error(e.message); process.exit(1); });
