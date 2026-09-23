#!/usr/bin/env node
/**
 * Builds the single-file calculator:
 *   src/template.html + src/talents.json + src/editions/*.json -> index.html
 *
 *   node build.js
 *
 * src/talents.json is the editable Classic+ dataset. src/editions/*.json are the
 * read-only ones the edition switcher offers alongside it (Forever, Vanilla, ...),
 * regenerated with tools/build-edition.js. Everything is inlined, so index.html
 * still works opened straight off disk.
 *
 * Edit src/talents.json by hand, or use the app's edit mode and export from there.
 * The page is data-driven, so new talents, extra rows and different rank counts
 * all render without touching the markup.
 */
const fs = require("fs");
const path = require("path");
const { validateDataset } = require("./src/validate.js");

const root = __dirname;
const tplPath = path.join(root, "src", "template.html");
const dataPath = path.join(root, "src", "talents.json");
const editionDir = path.join(root, "src", "editions");
const logoDir = path.join(root, "src", "logos");
const faviconPath = path.join(root, "src", "favicon.svg");
const edIconDir = path.join(root, "src", "edition-icons");
const outPath = path.join(root, "index.html");

// the order the switcher shows them in; anything else found is appended
const EDITION_ORDER = ["forever", "classic", "tbc", "wotlk", "cata"];

const tpl = fs.readFileSync(tplPath, "utf8");
const data = JSON.parse(fs.readFileSync(dataPath, "utf8"));

const problems = validateDataset(data);
if (problems.length) {
  console.error("src/talents.json has problems:\n  " + problems.join("\n  "));
  process.exit(1);
}

const editions = [];
if (fs.existsSync(editionDir)) {
  const files = fs.readdirSync(editionDir).filter(f => f.endsWith(".json"));
  const rank = f => {
    const i = EDITION_ORDER.indexOf(path.basename(f, ".json"));
    return i < 0 ? EDITION_ORDER.length : i;
  };
  for (const file of files.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))) {
    const ed = JSON.parse(fs.readFileSync(path.join(editionDir, file), "utf8"));
    const bad = validateDataset(ed.classes);
    if (bad.length) {
      console.error(`src/editions/${file} has problems:\n  ` + bad.join("\n  "));
      process.exit(1);
    }
    editions.push(ed);
  }
}

// Expansion logos for the switcher, inlined so the page stays a single file and
// its main control never depends on a third-party host staying up.
const logos = {};
if (fs.existsSync(logoDir)) {
  for (const file of fs.readdirSync(logoDir).filter(f => f.endsWith(".png"))) {
    const buf = fs.readFileSync(path.join(logoDir, file));
    logos[path.basename(file, ".png")] = "data:image/png;base64," + buf.toString("base64");
  }
}
const missingLogos = editions.filter(e => !logos[e.id]).map(e => e.id);
if (missingLogos.length) console.warn(`  no logo for ${missingLogos.join(", ")} - those tabs fall back to text`);

// Small round expansion badges for the compare board's panel headers.
const edIcons = {};
if (fs.existsSync(edIconDir)) {
  for (const file of fs.readdirSync(edIconDir).filter(f => f.endsWith(".png"))) {
    edIcons[path.basename(file, ".png")] =
      "data:image/png;base64," + fs.readFileSync(path.join(edIconDir, file)).toString("base64");
  }
}

// The tab icon, inlined as a data URI: no extra request, and it still shows when
// index.html is opened straight off disk. Percent-encoded rather than base64 so it
// stays readable and does not grow by a third.
let favicon = "";
if (fs.existsSync(faviconPath)) {
  const svg = fs.readFileSync(faviconPath, "utf8")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\s+/g, " ")
    .trim();
  favicon = "data:image/svg+xml," + encodeURIComponent(svg);
} else {
  console.warn("  src/favicon.svg is missing - the page will have no tab icon");
}

const version = require("./src/version.js").info();

for (const token of ["__TALENT_DATA__", "__EDITIONS__", "__LOGOS__", "__EDITION_ICONS__", "__FAVICON__", "__VERSION__"]) {
  if (!tpl.includes(token)) {
    console.error(`src/template.html is missing the ${token} placeholder`);
    process.exit(1);
  }
}

fs.writeFileSync(outPath, tpl
  .replace("__TALENT_DATA__", JSON.stringify(data))
  .replace("__EDITIONS__", JSON.stringify(editions))
  .replace("__LOGOS__", JSON.stringify(logos))
  .replace("__EDITION_ICONS__", JSON.stringify(edIcons))
  .replace("__FAVICON__", favicon)
  .replace("__VERSION__", JSON.stringify(version)));

const count = d => Object.values(d).reduce(
  (n, c) => n + c.trees.reduce((m, t) => m + t.talents.length, 0), 0);
console.log(
  `index.html  ${(fs.statSync(outPath).size / 1024).toFixed(0)}KB  ` +
  `(Classic+: ${Object.keys(data).length} classes, ${count(data)} talents)`);
for (const ed of editions) {
  console.log(`  + ${ed.name.padEnd(10)} ${Object.keys(ed.classes).length} classes, ${count(ed.classes)} talents`);
}
