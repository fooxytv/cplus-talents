"use strict";
/**
 * Fetching real characters from Blizzard's profile API.
 *
 * The one idea worth holding on to: a profile is a snapshot taken when the
 * character logged out, so the moment a reading describes is
 * `last_login_timestamp`, NOT the moment we asked. Stamping observations with
 * the poll time would make a two-day-old standing look fresh, which is exactly
 * the mistake this whole layer exists to avoid.
 *
 * Everything that talks to the network is injectable, so the tests run offline
 * against fixtures rather than against Blizzard.
 *
 * Credentials come from the environment and nowhere else:
 *
 *   BLIZZARD_CLIENT_ID      from develop.battle.net, free
 *   BLIZZARD_CLIENT_SECRET
 *
 * A client secret must never be written into a config file that gets committed.
 */

const fs = require("fs");
const path = require("path");
const ingest = require("./ingest");

const CONFIG = (() => {
  const file = path.join(__dirname, "config", "armory.json");
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (e) { return {}; }
})();

/* ---------------- talking to Blizzard ---------------- */

function namespaceFor(flavour, region) {
  const tpl = (CONFIG.namespaces || {})[flavour];
  if (!tpl) {
    throw new Error(
      `no namespace for flavour "${flavour}" - add one to sim/config/armory.json. ` +
      `Forever has none until Blizzard publishes it.`);
  }
  return tpl.replace("{region}", region);
}

const slug = s => String(s).toLowerCase().trim()
  .replace(/['’]/g, "")
  .replace(/\s+/g, "-")
  .replace(/[^a-z0-9\-]/g, "");

/** A name as the API wants it: lower case, accents kept and percent-encoded. */
const charPath = name => encodeURIComponent(String(name).toLowerCase());

function makeClient(opts = {}) {
  const fetchImpl = opts.fetch || globalThis.fetch;
  const clientId = opts.clientId || process.env.BLIZZARD_CLIENT_ID || "";
  const clientSecret = opts.clientSecret || process.env.BLIZZARD_CLIENT_SECRET || "";
  const oauthHost = opts.oauthHost || CONFIG.oauthHost || "https://oauth.battle.net";
  const apiHost = opts.apiHost || CONFIG.apiHost || "https://{region}.api.blizzard.com";
  const locale = opts.locale || CONFIG.locale || "en_GB";

  let token = null;
  let tokenExpires = 0;

  const configured = () => !!(clientId && clientSecret);

  async function getToken(force) {
    if (!configured()) {
      throw new Error("BLIZZARD_CLIENT_ID and BLIZZARD_CLIENT_SECRET are not set");
    }
    if (!force && token && Date.now() < tokenExpires - 60000) return token;

    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    const res = await fetchImpl(`${oauthHost}/token`, {
      method: "POST",
      headers: {
        Authorization: "Basic " + basic,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    if (!res.ok) throw new Error(`oauth failed: ${res.status}`);
    const body = await res.json();
    token = body.access_token;
    // expires_in is seconds; Blizzard's are long-lived, but honour it anyway
    tokenExpires = Date.now() + (Number(body.expires_in || 3600) * 1000);
    return token;
  }

  /**
   * One character's profile summary.
   *
   * Returns { found: false } for a 404 rather than throwing: a character that
   * has never logged out does not exist to the armory yet, and on launch night
   * that is the normal case, not an error.
   */
  async function character({ region, flavour, realm, name }) {
    const ns = namespaceFor(flavour, region);
    const host = apiHost.replace("{region}", region);
    const url = `${host}/profile/wow/character/${slug(realm)}/${charPath(name)}` +
      `?namespace=${encodeURIComponent(ns)}&locale=${encodeURIComponent(locale)}`;

    const call = async tok => fetchImpl(url, {
      headers: { Authorization: "Bearer " + tok },
    });

    let res = await call(await getToken());
    // a token can expire early if it was revoked; one retry, then give up
    if (res.status === 401) res = await call(await getToken(true));

    if (res.status === 404) return { found: false, status: 404 };
    if (res.status === 429) {
      const wait = Number(res.headers && res.headers.get && res.headers.get("retry-after")) || 60;
      return { found: false, status: 429, retryAfter: wait };
    }
    if (!res.ok) return { found: false, status: res.status };

    return { found: true, status: 200, body: await res.json() };
  }

  return { getToken, character, configured, namespaceFor, slug };
}

/* ---------------- turning a profile into a reading ---------------- */

const FACTIONS = { ALLIANCE: "Alliance", HORDE: "Horde" };

/**
 * A profile summary as an observation. The timestamp is the character's last
 * logout, because that is when this snapshot was actually true.
 */
function toObservation(body, botId) {
  const lastLogin = Number(body.last_login_timestamp);
  const observedAt = Number.isFinite(lastLogin) && lastLogin > 0
    ? new Date(lastLogin).toISOString()
    : new Date().toISOString();

  const faction = body.faction && (body.faction.type || body.faction.name);

  return {
    botId,
    source: "armory",
    observedAt,
    level: Number.isFinite(body.level) ? body.level : null,
    // "experience" is xp into the current level, which is what the bar shows
    xp: Number.isFinite(body.experience) ? body.experience : null,
    klass: body.character_class && body.character_class.name,
    race: body.race && body.race.name,
    faction: FACTIONS[String(faction).toUpperCase()] || (faction || ""),
    gender: body.gender && String(body.gender.name || body.gender.type || "").toLowerCase(),
    raw: {
      last_login_timestamp: body.last_login_timestamp,
      level: body.level,
      experience: body.experience,
      realm: body.realm && body.realm.slug,
    },
  };
}

/* ---------------- polling a race ---------------- */

/**
 * Fetch every armory-tracked character in a race and record what came back.
 *
 * Readings whose last-logout has not moved are skipped: they would be the same
 * snapshot written again, and an identical observedAt tells staleness nothing
 * new. They are counted so "nothing changed" and "nothing was fetched" stay
 * distinguishable.
 */
async function pollRace(db, q, race, opts = {}) {
  const client = opts.client || makeClient(opts);
  const flavour = opts.flavour || CONFIG.flavour || race.edition;
  const defaultRegion = opts.region || CONFIG.region || "eu";

  const bots = q.listBots.all(race.id).filter(b => b.source === "armory");
  const out = { checked: 0, updated: 0, unchanged: 0, missing: 0, failed: 0, levels: 0, notes: [] };

  for (const bot of bots) {
    out.checked++;
    let got;
    try {
      got = await client.character({
        region: bot.region || defaultRegion,
        flavour, realm: bot.realm, name: bot.name,
      });
    } catch (e) {
      out.failed++;
      out.notes.push(`${bot.name}: ${e.message}`);
      continue;
    }

    if (!got.found) {
      if (got.status === 404) out.missing++;
      else { out.failed++; out.notes.push(`${bot.name}: http ${got.status}`); }
      if (got.status === 429) {
        out.notes.push(`rate limited; asked to wait ${got.retryAfter}s`);
        break;                                   // stop the round, do not hammer
      }
      continue;
    }

    const obs = toObservation(got.body, bot.id);

    const last = q.lastObservation.get(race.id, bot.id);
    if (last && last.observed_at === obs.observedAt) { out.unchanged++; continue; }

    const changed = ingest.record(db, q, race, obs);
    out.updated++;
    out.levels += changed.levels.length;
    if (changed.ignored) out.notes.push(`${bot.name}: ${changed.ignored}`);
  }

  return out;
}

module.exports = { makeClient, toObservation, pollRace, namespaceFor, slug, CONFIG };
