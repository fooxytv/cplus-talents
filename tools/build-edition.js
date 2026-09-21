#!/usr/bin/env node
/**
 * Builds a read-only talent edition - src/editions/<id>.json - from the same
 * data Wowhead's own Classic talent calculators run on.
 *
 *   node tools/build-edition.js forever
 *   node tools/build-edition.js classic tbc wotlk cata
 *   node tools/build-edition.js all
 *
 * Two payload shapes come back from Wowhead, and both are handled here:
 *
 *   - Forever ships names, icons, prerequisites and every rank's tooltip text
 *     inline, so one request is the whole edition.
 *   - Vanilla / TBC / Wrath / Cata ship only spell ids, so each rank needs a
 *     tooltip request. Those are cached in tools/.cache, making re-runs free.
 *
 * Output is the same dataset shape as src/talents.json, wrapped in a little
 * metadata (point budget, level cap). src/validate.js checks it before it is
 * written, so a broken edition never reaches the page.
 */
const fs = require("fs");
const path = require("path");
const { validateDataset } = require("../src/validate.js");

const ROOT = path.join(__dirname, "..");
const CACHE = path.join(__dirname, ".cache");
const OUT_DIR = path.join(ROOT, "src", "editions");

const EDITIONS = {
  forever: {
    name: "Forever", tagline: "Classic+", slug: "forever", dataEnv: 4,
    maxLevel: 60, maxPoints: 51, inline: true, bgSet: "classic",
    about: "Blizzard's Classic+ trees, as they stand on Wowhead's Forever calculator.",
  },
  classic: {
    name: "Vanilla", tagline: "1.12", slug: "classic", dataEnv: 4,
    maxLevel: 60, maxPoints: 51, inline: false, bgSet: "classic",
    about: "The original 1.12 trees.",
  },
  tbc: {
    name: "TBC", tagline: "2.4.3", slug: "tbc", dataEnv: 5,
    maxLevel: 70, maxPoints: 61, inline: false, bgSet: "classic",
    about: "The Burning Crusade trees.",
  },
  wotlk: {
    name: "Wrath", tagline: "3.3.5", slug: "wotlk", dataEnv: 8,
    maxLevel: 80, maxPoints: 71, inline: false, bgSet: "wrath",
    about: "Wrath of the Lich King trees, Death Knight included.",
  },
  cata: {
    name: "Cataclysm", tagline: "4.3.4", slug: "cata", dataEnv: 11,
    maxLevel: 85, maxPoints: 41, inline: false, bgSet: "cata",
    about: "Cataclysm trees, where a spec is locked in at the first point.",
  },
};

/**
 * Wowhead talent-tab id -> the class it belongs to and the tree art to use.
 *
 * Vanilla, TBC, Wrath and Forever all share these ids. Cataclysm renumbered most
 * of them (Arms went from 161 to 746), so tabs that are not in here are resolved
 * from the tooltips instead - see classFromTooltip.
 */
const TABS = {
  41:  { klass: "Mage",    icon: "spell_fire_firebolt02" },
  61:  { klass: "Mage",    icon: "spell_frost_frostbolt02" },
  81:  { klass: "Mage",    icon: "spell_holy_magicalsentry" },
  161: { klass: "Warrior", icon: "ability_rogue_eviscerate" },
  163: { klass: "Warrior", icon: "inv_shield_06" },
  164: { klass: "Warrior", icon: "ability_warrior_innerrage" },
  181: { klass: "Rogue",   icon: "ability_backstab" },
  182: { klass: "Rogue",   icon: "ability_rogue_eviscerate" },
  183: { klass: "Rogue",   icon: "ability_stealth" },
  201: { klass: "Priest",  icon: "spell_holy_wordfortitude" },
  202: { klass: "Priest",  icon: "spell_holy_holybolt" },
  203: { klass: "Priest",  icon: "spell_shadow_shadowwordpain" },
  261: { klass: "Shaman",  icon: "spell_nature_lightning" },
  262: { klass: "Shaman",  icon: "spell_nature_magicimmunity" },
  263: { klass: "Shaman",  icon: "spell_nature_lightningshield" },
  281: { klass: "Druid",   icon: "ability_racial_bearform" },
  282: { klass: "Druid",   icon: "spell_nature_healingtouch" },
  283: { klass: "Druid",   icon: "spell_nature_starfall" },
  301: { klass: "Warlock", icon: "spell_shadow_rainoffire" },
  302: { klass: "Warlock", icon: "spell_shadow_deathcoil" },
  303: { klass: "Warlock", icon: "spell_shadow_metamorphosis" },
  361: { klass: "Hunter",  icon: "ability_hunter_beasttaming" },
  362: { klass: "Hunter",  icon: "ability_hunter_swiftstrike" },
  363: { klass: "Hunter",  icon: "ability_marksmanship" },
  381: { klass: "Paladin", icon: "spell_holy_auraoflight" },
  382: { klass: "Paladin", icon: "spell_holy_holybolt" },
  383: { klass: "Paladin", icon: "spell_holy_devotionaura" },
  398: { klass: "Death Knight", icon: "spell_deathknight_bloodpresence" },
  399: { klass: "Death Knight", icon: "spell_deathknight_frostpresence" },
  400: { klass: "Death Knight", icon: "spell_deathknight_unholypresence" },
};

const CLASS_ORDER = ["Warrior", "Paladin", "Hunter", "Rogue", "Priest",
                     "Shaman", "Mage", "Warlock", "Druid", "Death Knight"];

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

/** The talent description sits in the last quoted block of the tooltip html. */
function describe(html) {
  if (!html) return "";
  const blocks = [...String(html).matchAll(/<div class="q">([\s\S]*?)<\/div>/g)].map(m => m[1]);
  return clean(blocks.length ? blocks[blocks.length - 1] : "");
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
        const json = JSON.parse(await getText(url, `spell-${dataEnv}-${id}.json`));
        if (json && json.name) results.set(id, { name: json.name, icon: json.icon, desc: describe(json.tooltip) });
      } catch (e) { /* a missing rank just leaves a gap */ }
      done++;
      if (done % 250 === 0 || done === total) process.stdout.write(`\r  ${label}: ${done}/${total} spells`);
    }
  };
  await Promise.all(Array.from({ length: 10 }, worker));
  if (total) process.stdout.write("\n");
  return results;
}

/**
 * Every talent tooltip says which class it belongs to ("Requires Paladin"), so a
 * tab whose id we do not recognise can still be placed without guesswork.
 */
function classFromTooltip(html) {
  const m = String(html || "").replace(/<[^>]*>/g, "\n")
    .match(/Requires (Death Knight|Warrior|Paladin|Hunter|Rogue|Priest|Shaman|Mage|Warlock|Druid)\b/);
  return m ? m[1] : null;
}

/** Asks Wowhead what class a tab's talents require. Three votes, majority wins. */
async function resolveTab(tab, talents, dataEnv) {
  const votes = {};
  for (const t of Object.values(talents).slice(0, 3)) {
    try {
      const json = JSON.parse(await getText(
        `https://nether.wowhead.com/tooltip/spell/${t.ranks[0]}?dataEnv=${dataEnv}&locale=0`,
        `spell-${dataEnv}-${t.ranks[0]}.json`));
      const k = classFromTooltip(json.tooltip);
      if (k) votes[k] = (votes[k] || 0) + 1;
    } catch (e) { /* one bad tooltip should not decide a tab */ }
  }
  const best = Object.entries(votes).sort((a, b) => b[1] - a[1])[0];
  return best ? best[0] : null;
}

const posOf = (r, c) => String.fromCharCode(97 + r) + (c + 1);

/** Talent ids are what prereqs point at, so they have to be unique per tree. */
function uniqueId(taken, base) {
  let id = base, n = 2;
  while (taken.has(id)) id = base + " (" + n++ + ")";
  taken.add(id);
  return id;
}

async function buildEdition(key) {
  const spec = EDITIONS[key];
  if (!spec) throw new Error(`unknown edition "${key}" - try ${Object.keys(EDITIONS).join(", ")}`);
  console.log(`${spec.name}:`);

  const raw = await getText(
    `https://nether.wowhead.com/${spec.slug}/data/talents-classic?dv=17`, `talents-${spec.slug}.js`);
  const globalRaw = await getText(
    `https://nether.wowhead.com/${spec.slug}/data/global?dv=83`, `global-${spec.slug}.js`);

  const data = Object.values(extractPageData(raw)).find(v => v && v.talents);
  if (!data) throw new Error("no talent data in the payload for " + key);
  const globalData = extractPageData(globalRaw);
  const treeNames = globalData["wow.playerClass.specialization.names"] || {};
  const treeIcons = globalData["wow.playerClass.specialization.icons"] || {};

  // Which class each tab belongs to. Known ids come free; the rest are asked
  // about, which is what makes Cataclysm's renumbered tabs land correctly.
  const tabClass = {};
  for (const tab of Object.keys(data.talents)) {
    if (TABS[tab]) { tabClass[tab] = TABS[tab].klass; continue; }
    if (spec.inline) continue;   // no tooltips to ask, and Forever uses the known ids
    const resolved = await resolveTab(tab, data.talents[tab], spec.dataEnv);
    if (resolved) {
      tabClass[tab] = resolved;
      console.log(`  tab ${tab} (${treeNames[tab] || "?"}) -> ${resolved}`);
    }
  }

  // Classic-shaped payloads carry spell ids only, so each rank needs a tooltip.
  let spells = new Map();
  if (!spec.inline) {
    const ids = new Set();
    for (const tab of Object.keys(data.talents)) {
      if (!tabClass[tab]) continue;
      for (const k of Object.keys(data.talents[tab])) for (const id of data.talents[tab][k].ranks) ids.add(id);
    }
    spells = await fetchSpells([...ids], spec.dataEnv, spec.name);
  }

  const classes = {};
  const notes = [];
  let kept = 0, skipped = 0;

  for (const tab of Object.keys(data.talents)) {
    const klass = tabClass[tab];
    if (!klass) { skipped += Object.keys(data.talents[tab]).length; continue; }
    const where = klass + "/" + (treeNames[tab] || tab);

    const taken = new Set();
    const idToName = new Map();   // wowhead talent id -> the name prereqs point at
    const entries = [];

    for (const t of Object.values(data.talents[tab]).sort((a, b) => a.row - b.row || a.col - b.col)) {
      const ranks = spec.inline
        ? t.ranks.map((_, i) => clean(t.descriptions && t.descriptions[String(i + 1)]))
        : t.ranks.map(id => (spells.get(id) || {}).desc || "");
      const name = clean(spec.inline ? t.name : (spells.get(t.ranks[0]) || {}).name);

      if (!name || ranks.some(r => !r)) {
        notes.push(`${where}: dropped talent ${t.id} (no ${name ? "rank text" : "name"})`);
        skipped++;
        continue;
      }
      // the page shows one tooltip line per rank, and caps a talent at 5
      if (ranks.length > 5) {
        notes.push(`${where}: ${name} has ${ranks.length} ranks, trimmed to 5`);
        ranks.length = 5;
      }

      const id = uniqueId(taken, name);
      idToName.set(t.id, id);
      entries.push({
        wid: t.id,
        requires: t.requires || [],
        talent: {
          id: id,
          name: name,
          pos: posOf(t.row, t.col),
          icon: t.icon || (spells.get(t.ranks[0]) || {}).icon || "inv_misc_questionmark",
          maxRank: ranks.length,
          reqPoints: Number.isInteger(t.requiredPoints) ? t.requiredPoints : t.row * 5,
          ranks: ranks,
        },
      });
      kept++;
    }

    // prerequisites, now that every talent in the tab has its final name
    for (const entry of entries) {
      const req = entry.requires[0];
      if (!req) continue;
      const target = idToName.get(req.id);
      if (!target) {
        notes.push(`${where}: ${entry.talent.name} requires a talent that was dropped`);
        continue;
      }
      // the page gates on a fully ranked prerequisite; a partial one over-gates
      const pre = entries.find(x => x.wid === req.id);
      if (pre && Number.isInteger(req.qty) && req.qty !== pre.talent.maxRank) {
        notes.push(`${where}: ${entry.talent.name} needs ${req.qty}/${pre.talent.maxRank} ` +
          `of ${target}, shown as all ${pre.talent.maxRank}`);
      }
      entry.talent.prereq = target;
    }

    const cls = classes[klass] || (classes[klass] = { name: klass, trees: [] });
    const treeName = treeNames[tab] || ("Tab " + tab);
    cls.trees.push({
      id: treeName,
      name: treeName,
      icon: treeIcons[tab] || (TABS[tab] && TABS[tab].icon) || entries[0].talent.icon,
      bg: Number(tab),
      bgSet: spec.bgSet,
      talents: entries.map(e => e.talent),
    });
  }

  // trees read left to right in name order, the same as src/talents.json
  const ordered = {};
  for (const k of CLASS_ORDER) {
    if (!classes[k]) continue;
    classes[k].trees.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    ordered[k] = classes[k];
  }

  const problems = validateDataset(ordered);
  if (problems.length) {
    console.error(`  ${spec.name} does not validate:\n    ` + problems.join("\n    "));
    throw new Error(spec.name + " produced an invalid dataset");
  }

  const out = {
    id: key,
    name: spec.name,
    tagline: spec.tagline,
    about: spec.about,
    maxLevel: spec.maxLevel,
    maxPoints: spec.maxPoints,
    source: `https://www.wowhead.com/${spec.slug}/talent-calc`,
    generated: new Date().toISOString(),
    classes: ordered,
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, key + ".json");
  fs.writeFileSync(file, JSON.stringify(out));
  for (const n of notes) console.log("  note: " + n);
  console.log(`  src/editions/${key}.json  ${(fs.statSync(file).size / 1024).toFixed(0)}KB  ` +
    `${Object.keys(ordered).length} classes, ${kept} talents` + (skipped ? `, ${skipped} skipped` : ""));
}

(async () => {
  const args = process.argv.slice(2);
  const wanted = !args.length ? ["forever"]
    : args[0] === "all" ? Object.keys(EDITIONS)
    : args;
  for (const key of wanted) await buildEdition(key);
})().catch(e => { console.error(e.message); process.exit(1); });
