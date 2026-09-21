#!/usr/bin/env node
/**
 * Builds a class spellbook - src/spellbooks/<id>.json - listing what each class
 * learns and at what level.
 *
 *   node tools/build-spellbook.js forever
 *
 * Forever's talent payload carries no abilities at all, and the tooltip API has
 * no Forever dataEnv, so this takes a different route from build-edition.js:
 *
 *   1. Wowhead's class page (/forever/class=1/warrior) embeds the full ability
 *      list as a Listview data array - name, spell id and the level it is
 *      learned at. That page is HTML behind CloudFront, so it is loaded in real
 *      headless Chrome rather than with fetch.
 *   2. Icons and tooltip text come from /forever/tooltip/spell/<id>, a
 *      flavour-prefixed path that really is Forever-specific: a Forever-only
 *      spell resolves there and 404s under /classic/.
 *
 * Responses are cached in tools/.cache, so re-runs are nearly free.
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const CACHE = path.join(__dirname, ".cache");
const OUT_DIR = path.join(ROOT, "src", "spellbooks");

const BOOKS = {
  forever: { name: "Forever", slug: "forever", maxLevel: 60 },
  classic: { name: "Vanilla", slug: "classic", maxLevel: 60 },
  tbc:     { name: "TBC",     slug: "tbc",     maxLevel: 70 },
  wotlk:   { name: "Wrath",   slug: "wotlk",   maxLevel: 80 },
  cata:    { name: "Cataclysm", slug: "cata",  maxLevel: 85 },
};

/** Wowhead class ids, and the slug its class page lives under. */
const CLASSES = [
  { id: 1, slug: "warrior", name: "Warrior" },
  { id: 2, slug: "paladin", name: "Paladin" },
  { id: 3, slug: "hunter", name: "Hunter" },
  { id: 4, slug: "rogue", name: "Rogue" },
  { id: 5, slug: "priest", name: "Priest" },
  { id: 6, slug: "death-knight", name: "Death Knight" },
  { id: 7, slug: "shaman", name: "Shaman" },
  { id: 8, slug: "mage", name: "Mage" },
  { id: 9, slug: "warlock", name: "Warlock" },
  { id: 11, slug: "druid", name: "Druid" },
];

const UA = { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0 Safari/537.36" };

const CHROME_CANDIDATES = [
  process.env.CHROME,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter(Boolean);

function chrome() {
  const found = CHROME_CANDIDATES.find(p => fs.existsSync(p));
  if (!found) throw new Error("No Chrome found. Set CHROME=/path/to/chrome and retry.");
  return found;
}

/** Wowhead's HTML sits behind CloudFront, which refuses plain fetches. */
function loadPage(url, cacheKey) {
  const file = path.join(CACHE, cacheKey);
  if (fs.existsSync(file)) return fs.readFileSync(file, "utf8");
  const dom = execFileSync(chrome(), [
    "--headless=new", "--disable-gpu", "--virtual-time-budget=14000", "--dump-dom", url,
  ], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(file, dom);
  return dom;
}

async function getJson(url, cacheKey) {
  const file = path.join(CACHE, cacheKey);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  const res = await fetch(url, { headers: UA });
  const text = await res.text();
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(file, text);
  return JSON.parse(text);
}

/** Walks a balanced [...] or {...} from `start`, ignoring braces inside strings. */
function sliceBalanced(s, start, open, close) {
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) return s.slice(start, i + 1); }
  }
  return null;
}

function rowsFromClassPage(dom) {
  const at = dom.search(/data:\s*\[/);
  if (at < 0) return null;
  const text = sliceBalanced(dom, dom.indexOf("[", at), "[", "]");
  if (!text) return null;
  try { return JSON.parse(text); } catch (e) { return null; }
}

function clean(s) {
  return String(s == null ? "" : s)
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "\u0027")
    .replace(/\s+/g, " ")
    .trim();
}

/** The spell's own description is the last quoted block of the tooltip. */
function describe(html) {
  if (!html) return "";
  const blocks = [...String(html).matchAll(/<div class="q">([\s\S]*?)<\/div>/g)].map(m => m[1]);
  return clean(blocks.length ? blocks[blocks.length - 1] : "");
}

/** Fetches many tooltips with a bounded number of parallel requests. */
async function fetchSpells(ids, slug, label) {
  const results = new Map();
  const queue = ids.slice();
  const total = queue.length;
  let done = 0;

  const worker = async () => {
    while (queue.length) {
      const id = queue.shift();
      try {
        const json = await getJson(
          `https://nether.wowhead.com/${slug}/tooltip/spell/${id}?locale=0`,
          `sb-${slug}-${id}.json`);
        if (json && json.name) results.set(id, { icon: json.icon, desc: describe(json.tooltip) });
      } catch (e) { /* a missing spell just goes without an icon */ }
      done++;
      if (done % 250 === 0 || done === total) process.stdout.write(`\r  ${label}: ${done}/${total} spells`);
    }
  };
  await Promise.all(Array.from({ length: 10 }, worker));
  if (total) process.stdout.write("\n");
  return results;
}

/** Talent-granted spells share a name with a talent, so they can be marked. */
function talentNames(bookId) {
  const file = path.join(ROOT, "src", "editions", bookId + ".json");
  const out = {};
  if (!fs.existsSync(file)) return out;
  const ed = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const k of Object.keys(ed.classes)) {
    out[k] = new Set();
    for (const tree of ed.classes[k].trees) for (const t of tree.talents) out[k].add(t.name);
  }
  return out;
}

async function buildBook(key) {
  const spec = BOOKS[key];
  if (!spec) throw new Error(`unknown spellbook "${key}" - try ${Object.keys(BOOKS).join(", ")}`);
  console.log(`${spec.name}:`);

  const talents = talentNames(key);
  const classes = {};
  const wanted = new Set();
  const perClass = [];

  for (const cls of CLASSES) {
    let rows;
    try {
      rows = rowsFromClassPage(loadPage(
        `https://www.wowhead.com/${spec.slug}/class=${cls.id}/${cls.slug}`,
        `class-${spec.slug}-${cls.id}.html`));
    } catch (e) {
      console.log(`  ${cls.name}: page would not load (${e.message.slice(0, 60)})`);
      continue;
    }
    if (!rows) { console.log(`  ${cls.name}: no ability list on that page`); continue; }

    /**
     * The class page lists everything a class can possibly have, which is more
     * than a spellbook wants:
     *   cat 7          class abilities. Weapon skills and racials come under
     *                  other categories and belong to a different chrclass.
     *   skill non-empty rune engravings carry an empty skill array, which is how
     *                  Season of Discovery leaks into this data.
     * What survives is then split by whether a trainer teaches it - a row with a
     * source or a training cost is trained, anything else is simply granted,
     * which is why talent spells and starting abilities all sit at level 1.
     */
    const keep = rows.filter(r =>
      r.cat === 7 &&
      Array.isArray(r.skill) && r.skill.length > 0 &&
      typeof r.level === "number" && r.level > 0 && r.level <= spec.maxLevel &&
      typeof r.name === "string" && r.name &&
      !/^S0\d\s|Tuning and Overrides|\(DND\)|\(NYI\)/i.test(r.name));

    for (const r of keep) wanted.add(r.id);
    perClass.push({ cls: cls, rows: keep });
    console.log(`  ${cls.name.padEnd(13)} ${String(keep.length).padStart(4)} abilities` +
      (keep.length !== rows.length ? `  (${rows.length - keep.length} filtered out)` : ""));
  }

  if (!perClass.length) throw new Error("no class pages yielded an ability list");

  const spells = await fetchSpells([...wanted], spec.slug, spec.name);

  let total = 0;
  for (const { cls, rows } of perClass) {
    const list = rows.map(r => {
      const extra = spells.get(r.id) || {};
      const entry = {
        id: r.id,
        name: clean(r.name),
        level: r.level,
        icon: extra.icon || "inv_misc_questionmark",
      };
      if (r.rank) entry.rank = clean(r.rank);
      if (extra.desc) entry.desc = extra.desc;
      if (r.trainingcost) entry.cost = r.trainingcost;
      // taught by a trainer, as opposed to granted by a talent or on levelling
      if ((Array.isArray(r.source) && r.source.length) || r.trainingcost) entry.trained = true;
      if (talents[cls.name] && talents[cls.name].has(entry.name)) entry.talent = true;
      return entry;
    }).sort((a, b) => a.level - b.level ||
      (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) ||
      (a.rank || "").localeCompare(b.rank || ""));

    classes[cls.name] = list;
    total += list.length;
  }

  const out = {
    id: key,
    name: spec.name,
    maxLevel: spec.maxLevel,
    source: `https://www.wowhead.com/${spec.slug}/`,
    generated: new Date().toISOString(),
    classes: classes,
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, key + ".json");
  fs.writeFileSync(file, JSON.stringify(out));
  const flat = Object.values(classes).flat();
  const trained = flat.filter(a => a.trained).length;
  console.log(`  src/spellbooks/${key}.json  ${(fs.statSync(file).size / 1024).toFixed(0)}KB  ` +
    `${Object.keys(classes).length} classes, ${total} abilities ` +
    `(${trained} trained, ${total - trained} granted)`);
}

(async () => {
  const args = process.argv.slice(2);
  const wanted = !args.length ? ["forever"] : args[0] === "all" ? Object.keys(BOOKS) : args;
  for (const key of wanted) await buildBook(key);
})().catch(e => { console.error(e.message); process.exit(1); });
