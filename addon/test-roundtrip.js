#!/usr/bin/env node
/**
 * Checks the two halves still speak the same language: a build exported by the
 * real page is parsed by the real addon.
 *
 *   node addon/test-roundtrip.js
 *
 * The page half runs in headless Chrome against the built index.html; the addon
 * half runs in Lua. Without this, the export format could drift on one side and
 * nothing would notice until someone pasted a string into the game.
 */
const fs = require("fs"), os = require("os"), path = require("path");
const { execFileSync } = require("child_process");
const { pathToFileURL } = require("url");

const root = path.join(__dirname, "..");
const page = path.join(root, "index.html");

const CHROME = [
  process.env.CHROME,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
].filter(Boolean).find(p => fs.existsSync(p));

const LUA = [
  process.env.LUA,
  "C:/Users/simon/scoop/shims/lua.exe",
  "/usr/bin/lua",
  "/usr/bin/lua5.4",
].filter(Boolean).find(p => fs.existsSync(p));

if (!CHROME) { console.error("No Chrome found. Set CHROME=/path/to/chrome."); process.exit(1); }
if (!LUA) { console.error("No Lua found. Set LUA=/path/to/lua."); process.exit(1); }
if (!fs.existsSync(page)) { console.error("index.html is missing - run node build.js first."); process.exit(1); }

/* ---- the page half: export a real build ---- */
const probe = `setTimeout(() => {
  try {
    selectEdition(editionById("forever"));
    selectClass("Warrior");
    level = 60;
    resetAll();
    const fury = trees().find(t => t.name === "Fury");
    // a spread that reaches a deep talent, so tier ordering is exercised
    for (const n of ["Booming Voice", "Cruelty", "Unbridled Wrath", "Improved Cleave"]) {
      const t = fury.talents.find(x => x.name === n);
      if (t) learn(fury, t, true);
    }
    document.title = "ZZ" + exportForAddon("Fury roundtrip") + "ZZ";
  } catch (e) { document.title = "ZZERR " + e.message + "ZZ"; }
}, 600);`;

const html = fs.readFileSync(page, "utf8");
const at = html.lastIndexOf("</script>");
const tmpHtml = path.join(os.tmpdir(), "cplus-roundtrip.html");
fs.writeFileSync(tmpHtml, html.slice(0, at) + probe + html.slice(at));

const dom = execFileSync(CHROME, [
  "--headless=new", "--disable-gpu", "--virtual-time-budget=12000",
  "--dump-dom", pathToFileURL(tmpHtml).href,
], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
fs.unlinkSync(tmpHtml);

const title = (dom.match(/<title>([^<]*)<\/title>/) || [])[1] || "";
const exported = (title.match(/^ZZ([\s\S]*)ZZ$/) || [])[1];
if (!exported || exported.indexOf("ERR") === 0) {
  console.error("the page did not export a build: " + (exported || title));
  process.exit(1);
}
console.log("exported by the page:");
console.log("  " + exported);

/* ---- the addon half: parse it ---- */
const luaCheck = `
_G.GetNumTalentTabs = function() return 0 end
_G.GetNumTalents = function() return 0 end
_G.GetTalentInfo = function() return nil end
_G.GetUnspentTalentPoints = function() return 51 end
_G.UnitClass = function() return "Warrior", "WARRIOR" end
_G.InCombatLockdown = function() return false end
_G.LearnTalent = function() return false end
_G.UIParent, _G.UISpecialFrames, _G.SlashCmdList = {}, {}, {}
_G.CreateFrame = function()
  return setmetatable({}, { __index = function() return function() end end })
end
_G.DEFAULT_CHAT_FRAME = { AddMessage = function() end }

assert(loadfile("addon/CPlusTalents/CPlusTalents.lua"))("CPlusTalents")

local text = ...
local build, why = CPlusTalents.parseBuild(text)
if not build then
  print("FAIL  the addon could not parse it: " .. tostring(why))
  os.exit(1)
end

local n = 0
for _ in pairs(build.talents) do n = n + 1 end
print("parsed by the addon:")
print("  name    " .. build.name)
print("  class   " .. build.class)
print("  edition " .. build.edition)
print("  talents " .. n)
for _, name in ipairs(build.order) do
  print("    " .. name .. " = " .. build.talents[name])
end
if build.class ~= "WARRIOR" then print("FAIL  wrong class"); os.exit(1) end
if n == 0 then print("FAIL  no talents survived"); os.exit(1) end
os.exit(0)
`;

const tmpLua = path.join(os.tmpdir(), "cplus-roundtrip.lua");
fs.writeFileSync(tmpLua, luaCheck);

let out;
try {
  out = execFileSync(LUA, [tmpLua, exported], { encoding: "utf8", cwd: root });
} catch (e) {
  console.error((e.stdout || "") + (e.stderr || ""));
  console.error("\nroundtrip FAILED");
  fs.unlinkSync(tmpLua);
  process.exit(1);
}
fs.unlinkSync(tmpLua);
console.log(out.trim());

/* ---- and the names really are the page's, not positions ---- */
const names = exported.split("|")[4].split(",").map(p => p.split("=")[0]);
const bad = names.filter(n => !/[A-Za-z]/.test(n));
if (bad.length) {
  console.error("\nFAIL  some entries are not talent names: " + bad.join(", "));
  process.exit(1);
}

console.log("\nroundtrip OK - the page's export is readable by the addon");
