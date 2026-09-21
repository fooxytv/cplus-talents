#!/usr/bin/env node
/**
 * Exercises the HTTP API against a running server.
 *
 *   node test/api-tests.js                  # defaults to http://localhost:8080
 *   BASE=http://localhost:9000 node test/api-tests.js
 *
 * Leaves the server as it found it: any talent override it creates is removed.
 */
const BASE = process.env.BASE || "http://localhost:8080";

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log("PASS  " + name); }
  else { fail++; console.log("FAIL  " + name + (detail ? "  -> " + detail : "")); }
};

async function call(path, options) {
  const res = await fetch(BASE + path, options);
  let body = null;
  try { body = await res.json(); } catch (e) { /* some responses have no body */ }
  return { status: res.status, body: body };
}
const json = (method, payload) => ({
  method: method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(payload),
});

(async () => {
  // ---- health and config ----
  let r = await call("/api/health");
  ok("health responds", r.status === 200 && r.body.ok === true);

  r = await call("/api/config");
  const editMode = r.body && r.body.editMode;
  ok("config reports edit mode", r.status === 200 && typeof editMode === "boolean");

  // ---- talents ----
  r = await call("/api/talents");
  const dataset = r.body && r.body.talents;
  ok("talents endpoint returns a dataset", r.status === 200 && dataset && Object.keys(dataset).length === 9);

  // Whatever this server is serving right now gets put back before we exit, so a
  // run against a live instance can never cost someone their edited trees.
  const savedDataset = r.body.edited ? JSON.parse(JSON.stringify(dataset)) : null;
  if (savedDataset) console.log("NOTE  this server has edited talents; they will be restored at the end");

  // ---- library ----
  r = await call("/api/library");
  const lib = r.body && r.body.talents;
  ok("library has talents from all three expansions",
    Array.isArray(lib) && ["Classic", "TBC", "WotLK"].every(e => lib.some(t => t.expansion === e)),
    Array.isArray(lib) ? lib.length + " entries" : "no library");
  ok("library entries carry a description per rank",
    Array.isArray(lib) && lib.every(t => Array.isArray(t.ranks) && t.ranks.length === t.maxRank));
  ok("library includes Death Knight talents",
    Array.isArray(lib) && lib.some(t => t.klass === "Death Knight"));

  // ---- saved builds ----
  const legal = "warrior-00000000000000000050050005005410051";
  r = await call("/api/builds", json("POST", { name: "api test build", code: legal }));
  const created = r.body;
  ok("a legal build saves", r.status === 201 && created.id && created.points === 31, JSON.stringify(r.body).slice(0, 90));

  r = await call("/api/builds/" + created.id);
  ok("saved build reads back", r.status === 200 && r.body.code === legal);

  r = await call("/api/builds", json("POST", { name: "x", code: "warrior-5555555555555555555555555555555555555555" }));
  ok("an over-budget build is refused", r.status === 400);

  r = await call("/api/builds", json("POST", { name: "x", code: "deathknight-555" }));
  ok("an unknown class is refused", r.status === 400);

  // a code carries the talent layout it was built against, so a stale one says so
  r = await call("/api/talents");
  const stamp = r.body.fingerprints && r.body.fingerprints.Warrior;
  ok("the server publishes a layout fingerprint per class", typeof stamp === "string" && stamp.length > 0);

  r = await call("/api/builds", json("POST", { name: "x", code: legal + "." + stamp }));
  ok("a correctly stamped build saves", r.status === 201);
  if (r.status === 201) await call("/api/builds/" + r.body.id, { method: "DELETE" });

  r = await call("/api/builds", json("POST", { name: "x", code: legal + ".deadbeef" }));
  ok("a stale stamp is refused by name",
    r.status === 400 && /different version of the Warrior talents/.test(r.body.error || ""),
    r.body && r.body.error);

  r = await call("/api/builds/" + created.id, { method: "DELETE" });
  ok("a build deletes", r.status === 200);

  r = await call("/api/builds/" + created.id);
  ok("deleted build is gone", r.status === 404);

  // ---- editions ----
  r = await call("/api/config");
  const editions = (r.body && r.body.editions) || [];
  ok("config lists the editions", editions.length >= 1 && editions[0].id === "custom",
    JSON.stringify(editions));

  ok("a bare code still means the Classic+ trees", created.edition === "custom", created.edition);

  r = await call("/api/builds", json("POST", { name: "x", code: "nosuchedition:warrior-5" }));
  ok("an unknown edition is refused by name",
    r.status === 400 && /nosuchedition/.test(r.body.error || ""), r.body && r.body.error);

  const forever = editions.find(e => e.id === "forever");
  if (!forever) {
    console.log("SKIP  forever edition not built (node tools/build-edition.js forever)");
  } else {
    // build a legal Forever code the same way the page does, straight from the data
    const fs = require("fs");
    const path = require("path");
    const ed = JSON.parse(fs.readFileSync(
      path.join(__dirname, "..", "src", "editions", "forever.json"), "utf8"));
    const sorted = t => t.talents.slice().sort((a, b) => (a.pos < b.pos ? -1 : 1));
    const rowOf = p => p.charCodeAt(0) - 97;

    const trees = ed.classes.Druid.trees;
    const st = {};
    for (const tr of trees) { st[tr.id] = {}; for (const t of tr.talents) st[tr.id][t.id] = 0; }
    const bal = trees.find(t => t.name === "Balance");
    let spent = 0;
    for (const t of sorted(bal)) {
      if (spent >= 31) break;
      const above = bal.talents.reduce(
        (n, o) => n + (rowOf(o.pos) < rowOf(t.pos) ? st[bal.id][o.id] : 0), 0);
      if (above < t.reqPoints) continue;
      if (t.prereq) {
        const pre = bal.talents.find(x => x.id === t.prereq);
        if (st[bal.id][pre.id] < pre.maxRank) continue;
      }
      st[bal.id][t.id] = Math.min(t.maxRank, 31 - spent);
      spent += st[bal.id][t.id];
    }
    let digits = "";
    for (const tr of trees) for (const t of sorted(tr)) digits += st[tr.id][t.id];
    const fCode = "forever:druid-" + digits.replace(/0+$/, "");

    r = await call("/api/builds", json("POST", { name: "api test forever", code: fCode }));
    const fBuild = r.body;
    ok("a Forever build saves",
      r.status === 201 && fBuild.points === spent && fBuild.klass === "Druid",
      JSON.stringify(r.body).slice(0, 120));
    ok("it is stored against its edition", fBuild && fBuild.edition === "forever",
      fBuild && fBuild.edition);

    r = await call("/api/builds", json("POST", { name: "x", code: fCode + ".deadbeef" }));
    ok("a stale Forever stamp is refused",
      r.status === 400 && /different version of the Druid talents/.test(r.body.error || ""),
      r.body && r.body.error);

    r = await call("/api/builds", json("POST", { name: "x", code: "forever:deathknight-5" }));
    ok("a class Forever does not have is refused", r.status === 400);

    if (fBuild && fBuild.id) await call("/api/builds/" + fBuild.id, { method: "DELETE" });
  }

  // ---- editing the dataset ----
  if (!editMode) {
    console.log("SKIP  dataset editing (EDIT_MODE=0)");
  } else {
    const edited = JSON.parse(JSON.stringify(dataset));
    const balance = edited.Druid.trees.find(t => t.name === "Balance");
    const free = ["a4", "b1", "c2"].find(p => !balance.talents.some(t => t.pos === p));
    balance.talents.push({
      id: "API Test Talent", name: "API Test Talent", pos: free,
      icon: "inv_misc_questionmark", maxRank: 2, reqPoints: (free.charCodeAt(0) - 97) * 5,
      ranks: ["Does a thing.", "Does two things."],
    });

    r = await call("/api/talents", json("PUT", { talents: edited }));
    ok("a valid edited dataset saves", r.status === 200 && r.body.ok, JSON.stringify(r.body).slice(0, 120));

    r = await call("/api/talents");
    ok("the edit is served back",
      r.body.talents.Druid.trees.find(t => t.name === "Balance").talents.some(t => t.name === "API Test Talent"));

    // overlapping cells
    const clash = JSON.parse(JSON.stringify(dataset));
    const ct = clash.Druid.trees.find(t => t.name === "Balance");
    ct.talents[1].pos = ct.talents[0].pos;
    r = await call("/api/talents", json("PUT", { talents: clash }));
    ok("overlapping cells are refused", r.status === 400 && /shares cell/.test((r.body.problems || []).join(" ")));

    // rank count must match maxRank
    const ranksOff = JSON.parse(JSON.stringify(dataset));
    ranksOff.Druid.trees[0].talents[0].maxRank = 5;
    ranksOff.Druid.trees[0].talents[0].ranks = ["only one"];
    r = await call("/api/talents", json("PUT", { talents: ranksOff }));
    ok("a rank-count mismatch is refused", r.status === 400);

    // a prereq that does not exist
    const badPre = JSON.parse(JSON.stringify(dataset));
    badPre.Druid.trees[0].talents[0].prereq = "Nothing At All";
    r = await call("/api/talents", json("PUT", { talents: badPre }));
    ok("an unknown prereq is refused", r.status === 400);

    // a tier nobody can pay for
    const unreachable = JSON.parse(JSON.stringify(dataset));
    unreachable.Druid.trees[0].talents.find(t => t.pos[0] === "a").reqPoints = 30;
    r = await call("/api/talents", json("PUT", { talents: unreachable }));
    ok("an unreachable tier cost is refused", r.status === 400);

    // ---- version history ----
    r = await call("/api/talents/history");
    const versions = r.body.versions || [];
    ok("history lists versions", r.status === 200 && versions.length > 0, versions.length + " versions");
    ok("the last save was recorded", versions[0] && /saved from edit mode|history probe/.test(versions[0].note),
      versions[0] && versions[0].note);

    r = await call("/api/talents", json("PUT", { talents: edited, note: "history probe" }));
    ok("a save with a note records it", r.status === 200);
    r = await call("/api/talents/history");
    const noted = (r.body.versions || [])[0];
    ok("the note is stored against the version", noted && noted.note === "history probe", noted && noted.note);

    r = await call("/api/talents/history/" + noted.id);
    ok("a version can be read back in full",
      r.status === 200 && r.body.dataset && Object.keys(r.body.dataset).length === 9);

    // restoring an older version brings its talents back
    const oldest = versions[versions.length - 1];
    r = await call("/api/talents/history/" + oldest.id + "/restore", { method: "POST" });
    ok("an older version restores", r.status === 200 && r.body.ok);
    r = await call("/api/talents");
    ok("the restored talents are served",
      Object.keys(r.body.talents).length === 9 &&
      !r.body.talents.Druid.trees.find(t => t.name === "Balance").talents.some(t => t.name === "API Test Talent"));

    r = await call("/api/talents/history");
    ok("restoring keeps a copy of what it replaced",
      (r.body.versions || []).some(v => /before restoring version/.test(v.note)));

    r = await call("/api/talents/history/999999/restore", { method: "POST" });
    ok("restoring a missing version 404s", r.status === 404);

    r = await call("/api/talents", { method: "DELETE" });
    ok("the override resets", r.status === 200 && r.body.reset);

    r = await call("/api/config");
    ok("config reports no edits after reset", r.body.edited === false);

    // put the server back exactly as we found it
    if (savedDataset) {
      r = await call("/api/talents", json("PUT", { talents: savedDataset }));
      ok("the server's own edited talents were restored", r.status === 200 && r.body.ok);
    }
  }

  // ---- suggestion rate limit ----
  // Opt-in: this spends this machine's whole hourly allowance to prove the limit
  // is there, so it would be rude to do it on every run against a live server.
  //   RATE_LIMIT_TEST=1 node test/api-tests.js
  if (process.env.RATE_LIMIT_TEST === "1") {
    const mine = [];
    let limited = null;
    for (let i = 0; i < 40 && !limited; i++) {
      const res = await fetch(BASE + "/api/suggestions", json("POST",
        { body: "rate limit test " + i + " - safe to delete", author: "api-tests" }));
      const body = await res.json().catch(() => ({}));
      if (res.status === 201) mine.push(i);
      else if (res.status === 429) limited = { res: res, body: body };
      else { ok("rate limit test got an unexpected status", false, res.status); break; }
    }

    ok("a burst from one address is eventually refused", Boolean(limited),
      limited ? "" : "sent 40 with no 429 - is the limit far too high?");
    if (limited) {
      ok("the refusal says when to come back",
        /try again/i.test(limited.body.error || ""), limited.body.error);
      ok("and sets Retry-After", Number(limited.res.headers.get("retry-after")) > 0,
        limited.res.headers.get("retry-after"));
      ok("some got through before the limit bit", mine.length > 0, mine.length + " accepted");
    }

    // tidy up after ourselves - needs admin, which is everyone when no key is set
    const key = process.env.ADMIN_KEY || "";
    const listed = await call("/api/suggestions", { headers: key ? { "x-admin-key": key } : {} });
    if (listed.status === 200) {
      let removed = 0;
      for (const s of listed.body.suggestions) {
        if (s.author !== "api-tests") continue;
        const del = await call("/api/suggestions/" + s.id,
          { method: "DELETE", headers: key ? { "x-admin-key": key } : {} });
        if (del.status === 200) removed++;
      }
      ok("the test's own suggestions were cleared up", removed === mine.length,
        removed + " removed of " + mine.length);
    } else {
      console.log("NOTE  could not clear up the test suggestions (needs ADMIN_KEY)");
    }
    console.log("NOTE  this machine's suggestion allowance is now spent for the hour");
  } else {
    console.log("SKIP  suggestion rate limit (RATE_LIMIT_TEST=1 to include it)");
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("suite crashed:", e.message); process.exit(1); });
