#!/usr/bin/env node
/**
 * Serves the calculator and stores saved builds in SQLite.
 *
 *   node server.js              -> http://localhost:8080
 *   PORT=3000 DB_PATH=/data/talents.db node server.js
 *
 * No npm dependencies: http and sqlite both come from Node itself.
 */
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const { validateDataset } = require("./src/validate.js");

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || "0.0.0.0";
const ROOT = __dirname;
const DB_PATH = process.env.DB_PATH || path.join(ROOT, "data", "talents.db");
const MAX_POINTS = 51;
// Edit mode is on by default for local use; set EDIT_MODE=0 to make the app read-only.
const EDIT_MODE = process.env.EDIT_MODE !== "0";
/**
 * Set ADMIN_KEY and the talent trees become read-only to everyone who does not
 * send it - which is what makes this safe to put on a public URL. Left unset the
 * server behaves as it always did, so a LAN copy needs no configuring.
 */
const ADMIN_KEY = (process.env.ADMIN_KEY || "").trim();
const NEEDS_KEY = ADMIN_KEY.length > 0;
/**
 * LOCAL_BUILDS=1 keeps every visitor's saved builds in their own browser instead of
 * in one list everybody shares - which is what you want on a public URL, where a
 * shared list is really just a wall anyone can scribble on. Builds are shared by
 * URL either way: the address bar already holds the whole build.
 */
const LOCAL_BUILDS = process.env.LOCAL_BUILDS === "1";
/**
 * TRUST_PROXY=1 says a reverse proxy sits in front and its client-IP headers can be
 * believed. Set it ONLY when one really does: anything that can reach this server
 * directly can otherwise put whatever it likes in those headers and hand itself a
 * fresh rate limit for every request.
 */
const TRUST_PROXY = process.env.TRUST_PROXY === "1";
const SUGGEST_PER_IP_PER_HOUR = Number(process.env.SUGGEST_PER_IP_PER_HOUR || 5);
const SUGGEST_PER_HOUR = Number(process.env.SUGGEST_PER_HOUR || 200);

/* ---------------- storage ---------------- */
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS builds (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    klass      TEXT NOT NULL,
    code       TEXT NOT NULL,
    points     INTEGER NOT NULL,
    spec       TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`);
db.exec("CREATE INDEX IF NOT EXISTS builds_updated ON builds (updated_at DESC)");
// added with the edition switcher; builds saved before it are all Classic+ ones
if (!db.prepare("PRAGMA table_info(builds)").all().some(c => c.name === "edition")) {
  db.exec("ALTER TABLE builds ADD COLUMN edition TEXT NOT NULL DEFAULT 'custom'");
}
// Who may delete a build. The page keeps the token it got at save time, so you can
// remove your own build and nobody else's, without there being accounts.
if (!db.prepare("PRAGMA table_info(builds)").all().some(c => c.name === "owner")) {
  db.exec("ALTER TABLE builds ADD COLUMN owner TEXT NOT NULL DEFAULT ''");
}
db.exec(`
  CREATE TABLE IF NOT EXISTS suggestions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    body       TEXT NOT NULL,
    author     TEXT NOT NULL,
    edition    TEXT NOT NULL,
    created_at TEXT NOT NULL,
    handled    INTEGER NOT NULL DEFAULT 0
  )
`);
db.exec("CREATE INDEX IF NOT EXISTS suggestions_created ON suggestions (created_at DESC)");
db.exec(`
  CREATE TABLE IF NOT EXISTS talent_data (
    id         INTEGER PRIMARY KEY CHECK (id = 1),
    json       TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`);
// Every version of the talents that has ever been active, so a bad edit or a
// reset is always recoverable.
db.exec(`
  CREATE TABLE IF NOT EXISTS talent_history (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    json     TEXT NOT NULL,
    note     TEXT NOT NULL,
    saved_at TEXT NOT NULL,
    classes  INTEGER NOT NULL,
    talents  INTEGER NOT NULL
  )
`);
db.exec("CREATE INDEX IF NOT EXISTS history_saved ON talent_history (saved_at DESC)");

const q = {
  list: db.prepare("SELECT * FROM builds ORDER BY updated_at DESC LIMIT ?"),
  get: db.prepare("SELECT * FROM builds WHERE id = ?"),
  insert: db.prepare(`INSERT INTO builds (id, name, klass, edition, code, points, spec, created_at, updated_at)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  update: db.prepare(`UPDATE builds SET name = ?, klass = ?, edition = ?, code = ?, points = ?, spec = ?, updated_at = ?
                      WHERE id = ?`),
  remove: db.prepare("DELETE FROM builds WHERE id = ?"),
  setOwner: db.prepare("UPDATE builds SET owner = ? WHERE id = ?"),

  sugAdd: db.prepare(`INSERT INTO suggestions (body, author, edition, created_at)
                      VALUES (?, ?, ?, ?)`),
  sugList: db.prepare("SELECT * FROM suggestions ORDER BY id DESC LIMIT ?"),
  sugCount: db.prepare("SELECT COUNT(*) AS n FROM suggestions"),
  sugHandle: db.prepare("UPDATE suggestions SET handled = ? WHERE id = ?"),
  sugDrop: db.prepare("DELETE FROM suggestions WHERE id = ?"),
  sugRecent: db.prepare("SELECT COUNT(*) AS n FROM suggestions WHERE created_at > ?"),
  getData: db.prepare("SELECT json, updated_at FROM talent_data WHERE id = 1"),
  putData: db.prepare(`INSERT INTO talent_data (id, json, updated_at) VALUES (1, ?, ?)
                       ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`),
  dropData: db.prepare("DELETE FROM talent_data WHERE id = 1"),

  histList: db.prepare(`SELECT id, note, saved_at, classes, talents FROM talent_history
                        ORDER BY id DESC LIMIT ?`),
  histGet: db.prepare("SELECT * FROM talent_history WHERE id = ?"),
  histAdd: db.prepare(`INSERT INTO talent_history (json, note, saved_at, classes, talents)
                       VALUES (?, ?, ?, ?, ?)`),
  histCount: db.prepare("SELECT COUNT(*) AS n FROM talent_history"),
  histPrune: db.prepare(`DELETE FROM talent_history WHERE id NOT IN
                         (SELECT id FROM talent_history ORDER BY id DESC LIMIT ?)`),
  histDrop: db.prepare("DELETE FROM talent_history WHERE id = ?"),
};

const KEEP_VERSIONS = 60;

function countTalents(data) {
  return Object.values(data).reduce(
    (n, c) => n + (c.trees || []).reduce((m, t) => m + (t.talents || []).length, 0), 0);
}

/** Records a version of the talents. Called before anything replaces them. */
function snapshot(data, note) {
  q.histAdd.run(JSON.stringify(data), note, new Date().toISOString(),
    Object.keys(data).length, countTalents(data));
  q.histPrune.run(KEEP_VERSIONS);
}

/* ---------------- talent rules (server side, so junk never reaches the db) ---------------- */
const row = p => p.charCodeAt(0) - 97;
const sortedTalents = tree => tree.talents.slice().sort((a, b) => (a.pos < b.pos ? -1 : 1));
// class names travel in codes, and "Death Knight" has a space in it
const slug = k => k.toLowerCase().replace(/[^a-z]/g, "");

const SHIPPED = JSON.parse(fs.readFileSync(path.join(ROOT, "src", "talents.json"), "utf8"));
const LIBRARY_PATH = path.join(ROOT, "src", "library.json");
const EDITION_DIR = path.join(ROOT, "src", "editions");
const SPELLBOOK_DIR = path.join(ROOT, "src", "spellbooks");

/**
 * Spellbooks are big - a few hundred KB each - so unlike the talents they are not
 * baked into the page; it asks for one when you open the view. Only ids that were
 * found on disk at boot are servable, so the path can never be steered elsewhere.
 */
const SPELLBOOKS = new Set(
  fs.existsSync(SPELLBOOK_DIR)
    ? fs.readdirSync(SPELLBOOK_DIR).filter(f => f.endsWith(".json")).map(f => path.basename(f, ".json"))
    : []);

// Share codes depend on the talent layout, so everything reads the active dataset.
let DATA = SHIPPED;
let CLASS_BY_KEY = new Map();
let dataEditedAt = null;

let FINGERPRINTS = {};

/**
 * Read-only editions (Forever, Vanilla, ...) sit alongside the editable Classic+
 * dataset. The page has them baked in; the server keeps its own copy so it can
 * check a build code before storing it.
 */
const CUSTOM = "custom";
const EDITIONS = new Map();

// the order the page shows them in, so /api/config agrees with the switcher
const EDITION_ORDER = ["forever", "classic", "tbc", "wotlk", "cata"];

function loadEditions() {
  if (!fs.existsSync(EDITION_DIR)) return;
  const rank = f => {
    const i = EDITION_ORDER.indexOf(path.basename(f, ".json"));
    return i < 0 ? EDITION_ORDER.length : i;
  };
  const files = fs.readdirSync(EDITION_DIR).filter(f => f.endsWith(".json"))
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  for (const file of files) {
    try {
      const ed = JSON.parse(fs.readFileSync(path.join(EDITION_DIR, file), "utf8"));
      const problems = validateDataset(ed.classes);
      if (problems.length) throw new Error(problems[0]);
      EDITIONS.set(ed.id, {
        id: ed.id,
        name: ed.name,
        maxPoints: ed.maxPoints,
        data: ed.classes,
        byKey: new Map(Object.keys(ed.classes).map(k => [slug(k), k])),
        fingerprints: {},
      });
    } catch (e) {
      console.error(`skipping src/editions/${file}: ${e.message}`);
    }
  }
}

/** FNV-1a, so a share code can say which talent layout it was built against. */
function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/** Covers exactly what a code depends on: which talents, in which order, and how many ranks. */
function fingerprintOf(data, klass) {
  let s = "";
  for (const tree of data[klass].trees) {
    s += tree.id + "|";
    for (const t of sortedTalents(tree)) s += t.id + ":" + t.maxRank + ";";
  }
  return hash32(s);
}

function useDataset(next, editedAt) {
  DATA = next;
  CLASS_BY_KEY = new Map(Object.keys(DATA).map(k => [slug(k), k]));
  dataEditedAt = editedAt || null;
  FINGERPRINTS = {};
  for (const k of Object.keys(DATA)) FINGERPRINTS[k] = fingerprintOf(DATA, k);
}

/** The Classic+ dataset is mutable, so its entry is rebuilt on every lookup. */
function editionOf(id) {
  if (!id || id === CUSTOM) {
    return { id: CUSTOM, name: "Classic+", maxPoints: MAX_POINTS, data: DATA,
             byKey: CLASS_BY_KEY, fingerprints: FINGERPRINTS };
  }
  return EDITIONS.get(id) || null;
}

loadEditions();
for (const ed of EDITIONS.values()) {
  for (const k of Object.keys(ed.data)) ed.fingerprints[k] = fingerprintOf(ed.data, k);
}

function loadDataset() {
  const stored = q.getData.get();
  if (!stored) return useDataset(SHIPPED, null);
  try {
    const parsed = JSON.parse(stored.json);
    if (validateDataset(parsed).length) throw new Error("stored dataset no longer validates");
    useDataset(parsed, stored.updated_at);
  } catch (e) {
    console.error("falling back to the shipped talents:", e.message);
    useDataset(SHIPPED, null);
  }
}
loadDataset();

// so there is always something to go back to, even on a fresh database
if (q.histCount.get().n === 0) snapshot(SHIPPED, "talents this build shipped with");

/**
 * Decodes a share code. Codes are positional, so one built against a different
 * talent layout would quietly land on the wrong talents - the trailing
 * fingerprint catches that and says so rather than failing vaguely.
 */
function parseCode(code) {
  if (typeof code !== "string" || code.length > 400) return { ok: false, reason: "that is not a build code" };

  // "forever:druid-5000...." - a bare code means the Classic+ trees, which is
  // what every code written before editions existed was.
  const colon = code.indexOf(":");
  const edId = colon > 0 ? code.slice(0, colon).toLowerCase() : CUSTOM;
  const edition = editionOf(edId);
  if (!edition) return { ok: false, reason: `this server does not have the "${edId}" talents` };
  if (colon > 0) code = code.slice(colon + 1);

  const DATA = edition.data;
  const FINGERPRINTS = edition.fingerprints;
  const MAX_POINTS = edition.maxPoints;

  const dot = code.lastIndexOf(".");
  const stamp = dot > 0 ? code.slice(dot + 1) : null;
  if (stamp) code = code.slice(0, dot);

  const dash = code.indexOf("-");
  const klass = edition.byKey.get(slug(dash < 0 ? code : code.slice(0, dash)));
  if (!klass) return { ok: false, reason: "no such class in this build code" };

  if (stamp && FINGERPRINTS[klass] && stamp !== FINGERPRINTS[klass]) {
    return {
      ok: false,
      reason: "this build was made against a different version of the " + klass +
        " talents, so its points no longer line up",
    };
  }

  const digits = dash < 0 ? "" : code.slice(dash + 1);
  if (!/^\d*$/.test(digits)) return { ok: false, reason: "that build code is malformed" };

  const trees = DATA[klass].trees;
  const ranks = new Map();   // "tree\0talent" -> rank
  let n = 0;
  for (const tree of trees) {
    for (const talent of sortedTalents(tree)) {
      const v = Number(digits[n++] || 0);
      if (v > talent.maxRank) return { ok: false, reason: "a talent in that build has more ranks than it can hold" };
      ranks.set(tree.id + "\0" + talent.id, v);
    }
  }
  if (digits.length > n) return { ok: false, reason: "that build code is longer than this class has talents" };

  const perTree = [];
  let total = 0;
  for (const tree of trees) {
    let spent = 0;
    for (const talent of tree.talents) spent += ranks.get(tree.id + "\0" + talent.id);
    perTree.push(spent);
    total += spent;
  }
  if (total > MAX_POINTS) return { ok: false, reason: "that build spends " + total + " points, more than the " + MAX_POINTS + " available" };

  // tier gates count only points spent in rows above the talent; prereqs must be maxed
  for (const tree of trees) {
    for (const talent of tree.talents) {
      if (ranks.get(tree.id + "\0" + talent.id) === 0) continue;
      const above = tree.talents.reduce(
        (sum, other) => sum + (row(other.pos) < row(talent.pos) ? ranks.get(tree.id + "\0" + other.id) : 0), 0);
      if (above < talent.reqPoints) return { ok: false, reason: talent.name + " needs " + talent.reqPoints + " points spent above it" };
      if (talent.prereq) {
        const pre = tree.talents.find(t => t.id === talent.prereq);
        if (pre && ranks.get(tree.id + "\0" + pre.id) < pre.maxRank) {
          return { ok: false, reason: talent.name + " needs " + pre.name + " fully ranked first" };
        }
      }
    }
  }
  return { ok: true, klass: klass, edition: edition.id, points: total,
           spec: perTree.join("/"), stamp: FINGERPRINTS[klass] };
}

/* ---------------- rate limiting ---------------- */

/**
 * Who is asking. Behind the Cloudflare tunnel every request arrives from the
 * cloudflared container, so the socket address would lump all visitors together
 * and one of them could spend everyone's allowance. Cloudflare's own header is
 * the real client - but only believe it when a proxy is actually in front, or
 * anyone could claim a new address per request and never be limited at all.
 */
function clientIp(req) {
  if (TRUST_PROXY) {
    const cf = req.headers["cf-connecting-ip"];
    if (cf) return String(cf).trim();
    const xff = req.headers["x-forwarded-for"];
    if (xff) {
      // the rightmost hop is the one our own proxy appended, so it is the one
      // a client cannot forge by sending a header of their own
      const hops = String(xff).split(",").map(h => h.trim()).filter(Boolean);
      if (hops.length) return hops[hops.length - 1];
    }
  }
  return req.socket.remoteAddress || "unknown";
}

// Addresses are only ever held hashed, in memory, and never written to the db.
const IP_SALT = crypto.randomBytes(16);
const ipKey = req =>
  crypto.createHash("sha256").update(IP_SALT).update(clientIp(req)).digest("base64");

const HOUR_MS = 3600e3;
const MAX_TRACKED_IPS = 5000;
const hits = new Map();   // hashed ip -> timestamps inside the window

/** Sliding window. Only successful calls count, so a typo costs nobody anything. */
function rateLimit(key, limit, windowMs) {
  const now = Date.now();

  // forget stale callers, so this cannot grow without bound
  if (hits.size > MAX_TRACKED_IPS) {
    for (const [k, times] of hits) {
      if (!times.length || now - times[times.length - 1] > windowMs) hits.delete(k);
    }
    if (hits.size > MAX_TRACKED_IPS) hits.clear();
  }

  const times = (hits.get(key) || []).filter(t => now - t < windowMs);
  if (times.length >= limit) {
    hits.set(key, times);
    return { ok: false, retryAfter: Math.max(1, Math.ceil((windowMs - (now - times[0])) / 1000)) };
  }
  times.push(now);
  hits.set(key, times);
  return { ok: true };
}

const newId = () => crypto.randomBytes(6).toString("base64url").slice(0, 8);
const newToken = () => crypto.randomBytes(18).toString("base64url");
/** Ownership tokens are secrets, so they get a real hash - not the FNV one above. */
const tokenHash = t => crypto.createHash("sha256").update(String(t)).digest("hex");

/** Constant-time compare, so the admin key cannot be guessed a character at a time. */
function sameSecret(a, b) {
  const x = Buffer.from(String(a || ""));
  const y = Buffer.from(String(b || ""));
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

/** True when the caller proved they hold the admin key - or none is configured. */
function isAdmin(req, url) {
  if (!NEEDS_KEY) return true;
  const header = req.headers["x-admin-key"];
  if (header && sameSecret(header, ADMIN_KEY)) return true;
  // ?admin=<key> so the page can be opened straight into edit mode from a bookmark
  const param = url && url.searchParams.get("admin");
  return Boolean(param && sameSecret(param, ADMIN_KEY));
}

const denied = res => sendJson(res, 403, {
  error: NEEDS_KEY ? "that needs the admin key" : "edit mode is off (EDIT_MODE=0)",
});

/* ---------------- http helpers ---------------- */
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".png": "image/png",
  ".json": "application/json; charset=utf-8",
};

function sendJson(res, status, body, extraHeaders) {
  const text = JSON.stringify(body);
  res.writeHead(status, Object.assign({
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  }, extraHeaders || {}));
  res.end(text);
}

/*
 * Data files get an ETag and must-revalidate rather than a flat hour.
 *
 * A flat max-age was actively harmful: when the Season of Discovery runes were
 * removed from the Forever spellbook the server was serving the fix while
 * browsers kept the old copy for up to an hour, so the bug looked unfixed.
 * Revalidating costs a 304 - a few bytes - and means a data fix is visible on
 * the next request rather than whenever a cache happens to expire.
 *
 * Images and fonts keep the long cache: they are replaced by changing the name,
 * not the contents.
 */
const REVALIDATE = new Set([".json"]);

function sendFile(res, file, status = 200, req) {
  fs.readFile(file, (err, buf) => {
    if (err) return sendJson(res, 404, { error: "not found" });

    const ext = path.extname(file);
    const etag = '"' + crypto.createHash("sha1").update(buf).digest("base64").slice(0, 22) + '"';

    if (req && req.headers["if-none-match"] === etag) {
      res.writeHead(304, { etag, "cache-control": "no-cache" });
      return res.end();
    }

    const cache = ext === ".html" ? "no-cache"
      : REVALIDATE.has(ext) ? "no-cache"
      : "public, max-age=3600";

    res.writeHead(status, {
      "content-type": TYPES[ext] || "application/octet-stream",
      "content-length": buf.length,
      "cache-control": cache,
      etag,
    });
    res.end(buf);
  });
}

function readBody(req, limit = 8 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", c => {
      size += c.length;
      if (size > limit) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); }
      catch (e) { reject(new Error("invalid json")); }
    });
    req.on("error", reject);
  });
}

const cleanName = v =>
  (typeof v === "string" ? v : "")
    .split("").filter(c => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127).join("")
    .trim().slice(0, 40);

/** Same idea as cleanName, but keeps newlines so a suggestion can have paragraphs. */
const NL = String.fromCharCode(10);
const cleanText = (v, max) => String(v == null ? "" : v)
  .split(String.fromCharCode(13)).join("")
  .split("").filter(c => c === NL || (c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127)).join("")
  .trim().slice(0, max);

/* ---------------- api ---------------- */
async function api(req, res, url) {
  const parts = url.pathname.split("/").filter(Boolean);   // ["api","builds", id?]
  const id = parts[2];

  if (parts[1] === "health") return sendJson(res, 200, { ok: true });

  if (parts[1] === "config") {
    return sendJson(res, 200, {
      editMode: EDIT_MODE && isAdmin(req, url),
      // so the page can tell "no edit mode here" from "you just need the key"
      adminKeyRequired: NEEDS_KEY,
      localBuilds: LOCAL_BUILDS,
      spellbooks: [...SPELLBOOKS],
      edited: Boolean(dataEditedAt),
      editedAt: dataEditedAt,
      maxPoints: MAX_POINTS,
      editions: [{ id: CUSTOM, name: "Classic+", maxPoints: MAX_POINTS }].concat(
        [...EDITIONS.values()].map(e => ({ id: e.id, name: e.name, maxPoints: e.maxPoints }))),
    });
  }

  // ---- spellbooks: what each class learns, and when ----
  if (parts[1] === "spellbook") {
    if (req.method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
    const id = parts[2];
    // membership of the set built at boot, so no path from the url reaches disk
    if (!id || !SPELLBOOKS.has(id)) return sendJson(res, 404, { error: "no spellbook for that edition" });
    return sendFile(res, path.join(SPELLBOOK_DIR, id + ".json"), 200, req);
  }

  // ---- suggestions: anyone may leave one, only an admin may read them ----
  if (parts[1] === "suggestions") {
    if (req.method === "POST") {
      let body;
      try { body = await readBody(req); }
      catch (e) { return sendJson(res, 400, { error: e.message }); }

      const text = cleanText(body && body.body, 1000);
      if (text.length < 4) return sendJson(res, 400, { error: "say a little more than that" });

      // One address at a time first: the point of this limit is that a single
      // visitor being a nuisance cannot use up everyone else's allowance.
      const perIp = rateLimit(ipKey(req), SUGGEST_PER_IP_PER_HOUR, HOUR_MS);
      if (!perIp.ok) {
        return sendJson(res, 429,
          { error: "you have sent a few already - try again in " +
                   Math.ceil(perIp.retryAfter / 60) + " min" },
          { "retry-after": String(perIp.retryAfter) });
      }

      // and a much higher backstop across everyone, so a flood from many
      // addresses still cannot fill the disk
      const hourAgo = new Date(Date.now() - HOUR_MS).toISOString();
      if (q.sugRecent.get(hourAgo).n >= SUGGEST_PER_HOUR) {
        return sendJson(res, 429, { error: "plenty of suggestions just came in - try again later" },
          { "retry-after": "600" });
      }

      q.sugAdd.run(text, cleanText(body.author, 60), cleanText(body.edition, 20),
        new Date().toISOString());
      return sendJson(res, 201, { ok: true });
    }

    if (!isAdmin(req, url)) return sendJson(res, 403, { error: "that needs the admin key" });

    const sugId = Number(parts[2]);
    if (req.method === "GET" && !parts[2]) {
      const limit = Math.min(Number(url.searchParams.get("limit")) || 200, 500);
      return sendJson(res, 200, { suggestions: q.sugList.all(limit), total: q.sugCount.get().n });
    }
    if (req.method === "POST" && sugId) {
      q.sugHandle.run(1, sugId);
      return sendJson(res, 200, { handled: sugId });
    }
    if (req.method === "DELETE" && sugId) {
      const gone = q.sugDrop.run(sugId);
      return gone.changes ? sendJson(res, 200, { deleted: sugId })
                          : sendJson(res, 404, { error: "no such suggestion" });
    }
    return sendJson(res, 405, { error: "method not allowed" });
  }

  // The talent layout itself. GET is always allowed; writing needs edit mode.
  if (parts[1] === "talents") {

    // ---- version history: /api/talents/history[/<id>[/restore]] ----
    if (parts[2] === "history") {
      const versionId = parts[3] ? Number(parts[3]) : null;
      // history is an editing tool, notes and all - not something visitors browse
      if (!isAdmin(req, url)) return denied(res);

      if (req.method === "GET" && !versionId) {
        const limit = Math.min(Number(url.searchParams.get("limit")) || KEEP_VERSIONS, KEEP_VERSIONS);
        return sendJson(res, 200, { versions: q.histList.all(limit), keep: KEEP_VERSIONS });
      }
      if (req.method === "GET" && versionId) {
        const v = q.histGet.get(versionId);
        if (!v) return sendJson(res, 404, { error: "no such version" });
        return sendJson(res, 200, {
          id: v.id, note: v.note, savedAt: v.saved_at,
          classes: v.classes, talents: v.talents, dataset: JSON.parse(v.json),
        });
      }

      if (!EDIT_MODE || !isAdmin(req, url)) return denied(res);

      if (req.method === "POST" && versionId && parts[4] === "restore") {
        const v = q.histGet.get(versionId);
        if (!v) return sendJson(res, 404, { error: "no such version" });

        let restored;
        try { restored = JSON.parse(v.json); }
        catch (e) { return sendJson(res, 500, { error: "that version is unreadable" }); }

        const problems = validateDataset(restored);
        if (problems.length) {
          return sendJson(res, 400, { error: "that version no longer validates", problems: problems.slice(0, 25) });
        }
        // the state being replaced is itself worth keeping
        snapshot(DATA, "before restoring version " + versionId);

        const now = new Date().toISOString();
        q.putData.run(JSON.stringify(restored), now);
        useDataset(restored, now);
        snapshot(restored, "restored from version " + versionId);
        return sendJson(res, 200, { ok: true, restoredFrom: versionId, editedAt: now });
      }

      if (req.method === "DELETE" && versionId) {
        const gone = q.histDrop.run(versionId);
        return gone.changes
          ? sendJson(res, 200, { deleted: versionId })
          : sendJson(res, 404, { error: "no such version" });
      }
      return sendJson(res, 405, { error: "method not allowed" });
    }

    if (req.method === "GET") {
      return sendJson(res, 200, { talents: DATA, fingerprints: FINGERPRINTS, edited: Boolean(dataEditedAt), editedAt: dataEditedAt });
    }
    if (!EDIT_MODE || !isAdmin(req, url)) return denied(res);

    if (req.method === "PUT") {
      let body;
      try { body = await readBody(req, 8 * 1024 * 1024); }
      catch (e) { return sendJson(res, 400, { error: e.message }); }

      const next = body && body.talents;
      const problems = validateDataset(next);
      if (problems.length) {
        return sendJson(res, 400, { error: "that dataset is not valid", problems: problems.slice(0, 25) });
      }
      const now = new Date().toISOString();
      q.putData.run(JSON.stringify(next), now);
      useDataset(next, now);
      snapshot(next, cleanName(body.note) || "saved from edit mode");
      return sendJson(res, 200, { ok: true, editedAt: now });
    }

    if (req.method === "DELETE") {
      // a reset throws away the edited trees, so keep a copy first
      if (dataEditedAt) snapshot(DATA, "before reset to shipped talents");
      q.dropData.run();
      useDataset(SHIPPED, null);
      return sendJson(res, 200, { ok: true, reset: true });
    }
    return sendJson(res, 405, { error: "method not allowed" });
  }

  // Every Classic / TBC / Wrath talent, for the edit-mode picker.
  if (parts[1] === "library") {
    if (req.method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
    if (!fs.existsSync(LIBRARY_PATH)) {
      return sendJson(res, 404, { error: "library.json is missing - run: node tools/build-library.js" });
    }
    return sendFile(res, LIBRARY_PATH);
  }

  if (parts[1] !== "builds") return sendJson(res, 404, { error: "unknown endpoint" });

  // the owner hash never leaves the server - it is only ever compared against
  const publicBuild = b => { const { owner, ...rest } = b; return rest; };

  if (req.method === "GET" && !id) {
    const limit = Math.min(Number(url.searchParams.get("limit")) || 100, 500);
    return sendJson(res, 200, { builds: q.list.all(limit).map(publicBuild) });
  }

  if (req.method === "GET" && id) {
    const build = q.get.get(id);
    return build ? sendJson(res, 200, publicBuild(build)) : sendJson(res, 404, { error: "no such build" });
  }

  if (req.method === "POST" || req.method === "PUT") {
    // in browser-local mode the shared store is the admin's alone, so a public
    // visitor cannot fill it up - they keep their builds in their own browser
    if (LOCAL_BUILDS && !isAdmin(req, url)) {
      return sendJson(res, 403, { error: "builds are kept in your own browser on this server" });
    }

    let body;
    try { body = await readBody(req); }
    catch (e) { return sendJson(res, 400, { error: e.message }); }

    const parsed = parseCode(body.code);
    if (!parsed.ok) return sendJson(res, 400, { error: parsed.reason });

    const name = cleanName(body.name) || `${parsed.klass} ${parsed.points} pts`;
    const now = new Date().toISOString();

    if (req.method === "PUT") {
      const existing = q.get.get(id);
      if (!existing) return sendJson(res, 404, { error: "no such build" });
      const putToken = req.headers["x-build-token"];
      const mine = !existing.owner || (putToken && sameSecret(tokenHash(putToken), existing.owner));
      if (!mine && !isAdmin(req, url)) {
        return sendJson(res, 403, { error: "that build was saved by someone else" });
      }
      q.update.run(name, parsed.klass, parsed.edition, body.code, parsed.points, parsed.spec, now, id);
      return sendJson(res, 200, publicBuild(q.get.get(id)));
    }

    const fresh = newId();
    const token = newToken();
    q.insert.run(fresh, name, parsed.klass, parsed.edition, body.code, parsed.points, parsed.spec, now, now);
    q.setOwner.run(tokenHash(token), fresh);
    // the only time the token is ever sent; the page keeps it to allow a delete later
    return sendJson(res, 201, Object.assign(publicBuild(q.get.get(fresh)), { token: token }));
  }

  if (req.method === "DELETE" && id) {
    const build = q.get.get(id);
    if (!build) return sendJson(res, 404, { error: "no such build" });
    // yours to delete if you saved it, or if you hold the admin key. Builds saved
    // before ownership existed have no owner, so they stay deletable by anyone.
    const token = req.headers["x-build-token"];
    const owned = !build.owner || (token && sameSecret(tokenHash(token), build.owner));
    if (!owned && !isAdmin(req, url)) {
      return sendJson(res, 403, { error: "that build was saved by someone else" });
    }
    q.remove.run(id);
    return sendJson(res, 200, { deleted: id });
  }

  return sendJson(res, 405, { error: "method not allowed" });
}

/* ---------------- server ---------------- */
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (url.pathname.startsWith("/api/")) {
    api(req, res, url).catch(err => {
      console.error("api error:", err);
      sendJson(res, 500, { error: "server error" });
    });
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    return sendJson(res, 405, { error: "method not allowed" });
  }

  // /b/<id> is a share link — the page fetches the build itself
  if (url.pathname === "/" || url.pathname === "/index.html" || url.pathname.startsWith("/b/")) {
    return sendFile(res, path.join(ROOT, "index.html"));
  }
  if (url.pathname === "/docs/screenshot.png") {
    return sendFile(res, path.join(ROOT, "docs", "screenshot.png"));
  }
  return sendJson(res, 404, { error: "not found" });
});

server.listen(PORT, HOST, () => {
  const shown = HOST === "0.0.0.0" ? "localhost" : HOST;
  console.log(`Classic+ talents on http://${shown}:${PORT}`);
  console.log(`sqlite: ${DB_PATH}`);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    server.close(() => { try { db.close(); } catch (e) {} process.exit(0); });
  });
}
