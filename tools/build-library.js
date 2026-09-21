#!/usr/bin/env node
/**
 * Builds src/library.json — every talent from Classic, TBC and Wrath, with each
 * rank's tooltip text, so edit mode can search them and drop them into a tree.
 *
 *   node tools/build-library.js
 *
 * Data comes from the same endpoints Wowhead's own talent calculator uses:
 * the tree structure in one request per expansion, then one tooltip request per
 * spell rank. Results are cached in tools/.cache so re-runs are nearly free.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const CACHE = path.join(__dirname, ".cache");
const OUT = path.join(ROOT, "src", "library.json");

// dataEnv values Wowhead uses per expansion (verified against expansion-exclusive spells)
const EXPANSIONS = [
  { key: "Classic", slug: "classic", dataEnv: 4 },
  { key: "TBC", slug: "tbc", dataEnv: 5 },
  { key: "WotLK", slug: "wotlk", dataEnv: 8 },
];

const CLASS_BY_TAB = {
  41: "Mage", 61: "Mage", 81: "Mage",
  161: "Warrior", 163: "Warrior", 164: "Warrior",
  181: "Rogue", 182: "Rogue", 183: "Rogue",
  201: "Priest", 202: "Priest", 203: "Priest",
  261: "Shaman", 262: "Shaman", 263: "Shaman",
  281: "Druid", 282: "Druid", 283: "Druid",
  301: "Warlock", 302: "Warlock", 303: "Warlock",
  361: "Hunter", 362: "Hunter", 363: "Hunter",
  381: "Paladin", 382: "Paladin", 383: "Paladin",
  398: "Death Knight", 399: "Death Knight", 400: "Death Knight",
};

const UA = { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0 Safari/537.36" };
const BACKSLASH = 92, QUOTE = 34, OPEN = 123, CLOSE = 125;

/** Pulls the JSON payloads out of a WH.setPageData(...) bundle. */
function extractPageData(raw) {
  const out = {};
  const re = /WH\.setPageData\("([^"]+)",/g;
  let m;
  while ((m = re.exec(raw))) {
    const i = raw.indexOf("{", m.index + m[0].length - 1);
    if (i < 0) continue;
    let depth = 0, inStr = false, esc = false, end = -1;
    for (let p = i; p < raw.length; p++) {
      const c = raw.charCodeAt(p);
      if (inStr) {
        if (esc) esc = false;
        else if (c === BACKSLASH) esc = true;
        else if (c === QUOTE) inStr = false;
        continue;
      }
      if (c === QUOTE) inStr = true;
      else if (c === OPEN) depth++;
      else if (c === CLOSE) { depth--; if (depth === 0) { end = p + 1; break; } }
    }
    if (end > 0) {
      try { out[m[1]] = JSON.parse(raw.slice(i, end)); } catch (e) { /* skip */ }
      re.lastIndex = end;
    }
  }
  return out;
}

async function getText(url, cacheKey) {
  const file = path.join(CACHE, cacheKey);
  if (fs.existsSync(file)) return fs.readFileSync(file, "utf8");
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(url + " -> " + res.status);
  const text = await res.text();
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(file, text);
  return text;
}

/** The talent description sits in the second table of the tooltip html. */
function describe(html) {
  if (!html) return "";
  const blocks = [...String(html).matchAll(/<div class="q">([\s\S]*?)<\/div>/g)].map(m => m[1]);
  const text = blocks.length ? blocks[blocks.length - 1] : "";
  return text
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** Fetches many spell tooltips with a bounded number of parallel requests. */
async function fetchSpells(ids, dataEnv, label) {
  const results = new Map();
  const queue = ids.slice();
  const total = queue.length;
  let done = 0;

  const worker = async () => {
    while (queue.length) {
      const id = queue.shift();
      const url = `https://nether.wowhead.com/tooltip/spell/${id}?dataEnv=${dataEnv}&locale=0`;
      try {
        const body = await getText(url, `spell-${dataEnv}-${id}.json`);
        const json = JSON.parse(body);
        if (json && json.name) results.set(id, { name: json.name, icon: json.icon, desc: describe(json.tooltip) });
      } catch (e) { /* a missing rank just leaves a gap */ }
      done++;
      if (done % 250 === 0 || done === total) {
        process.stdout.write(`\r  ${label}: ${done}/${total} spells`);
      }
    }
  };
  await Promise.all(Array.from({ length: 10 }, worker));
  process.stdout.write("\n");
  return results;
}

(async () => {
  const talents = [];

  for (const exp of EXPANSIONS) {
    console.log(`${exp.key}:`);
    const raw = await getText(
      `https://nether.wowhead.com/${exp.slug}/data/talents-classic?dv=17`,
      `talents-${exp.slug}.js`);
    const globalRaw = await getText(
      `https://nether.wowhead.com/${exp.slug}/data/global?dv=83`,
      `global-${exp.slug}.js`);

    const data = Object.values(extractPageData(raw)).find(v => v && v.talents);
    const specNames = extractPageData(globalRaw)["wow.playerClass.specialization.names"] || {};
    if (!data) throw new Error("no talent data for " + exp.key);

    const ids = new Set();
    for (const tab of Object.keys(data.talents)) {
      for (const key of Object.keys(data.talents[tab])) {
        for (const spell of data.talents[tab][key].ranks) ids.add(spell);
      }
    }
    const spells = await fetchSpells([...ids], exp.dataEnv, exp.key);

    let kept = 0, skipped = 0;
    for (const tab of Object.keys(data.talents)) {
      const klass = CLASS_BY_TAB[tab];
      const tree = specNames[tab] || ("Tab " + tab);
      if (!klass) { skipped++; continue; }

      for (const key of Object.keys(data.talents[tab])) {
        const t = data.talents[tab][key];
        const ranks = t.ranks.map(id => spells.get(id)).filter(Boolean);
        if (!ranks.length) { skipped++; continue; }

        talents.push({
          key: `${exp.key.toLowerCase()}-${tab}-${t.id}`,
          expansion: exp.key,
          klass: klass,
          tree: tree,
          name: ranks[0].name,
          icon: t.icon || ranks[0].icon,
          maxRank: t.ranks.length,
          row: t.row,
          col: t.col,
          reqPoints: t.row * 5,
          ranks: t.ranks.map((id, i) => (spells.get(id) || ranks[Math.min(i, ranks.length - 1)]).desc),
        });
        kept++;
      }
    }
    console.log(`  ${kept} talents kept, ${skipped} skipped`);
  }

  fs.writeFileSync(OUT, JSON.stringify({ generated: new Date().toISOString(), talents: talents }));
  const size = (fs.statSync(OUT).size / 1024).toFixed(0);
  const byExp = {};
  for (const t of talents) byExp[t.expansion] = (byExp[t.expansion] || 0) + 1;
  console.log(`\nsrc/library.json  ${size}KB  ${talents.length} talents  ` +
    Object.entries(byExp).map(([k, v]) => `${k}:${v}`).join("  "));
})();
