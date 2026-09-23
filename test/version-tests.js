#!/usr/bin/env node
"use strict";
/**
 * node test/version-tests.js
 *
 * The footer exists so a deploy can be checked rather than assumed. That only
 * works if the version is right, so these guard the two ways it can go wrong:
 * claiming a commit it is not, or quietly falling back to nothing.
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
let passed = 0;
const failures = [];
const ok = (name, cond) => { if (cond) passed++; else failures.push(name); };

/* Loaded fresh each time, since it reads the environment at call time. */
const load = () => {
  delete require.cache[require.resolve("../src/version.js")];
  return require("../src/version.js");
};

const saved = {
  GIT_SHA: process.env.GIT_SHA,
  GIT_DATE: process.env.GIT_DATE,
  GIT_DIRTY: process.env.GIT_DIRTY,
  BUILD_TIME: process.env.BUILD_TIME,
};
const clearEnv = () => {
  for (const k of Object.keys(saved)) delete process.env[k];
};
const restoreEnv = () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
};

/* ---------------- from the environment ---------------- */
/*
 * This is the path that matters in production: the image cannot see .git, so
 * the values are handed to it. If the environment were ignored, every deployed
 * page would read "dev" and the footer would be useless.
 */
clearEnv();
process.env.GIT_SHA = "abc1234";
process.env.GIT_DATE = "2026-11-04";
process.env.BUILD_TIME = "2026-11-04T23:00:00Z";
let v = load().info();

ok("the commit comes from the environment", v.sha === "abc1234");
ok("the version is the commit date", v.version === "2026.11.04");
ok("the build time is kept", v.built === "2026-11-04T23:00:00Z");
ok("the commit url points at the commit",
   v.commitUrl === "https://github.com/fooxytv/cplus-talents/commit/abc1234");
ok("a clean build is not marked dirty", v.dirty === false);

process.env.GIT_DIRTY = "1";
ok("a dirty build says so", load().info().dirty === true);

ok("the label is version and commit", (() => {
  const mod = load();
  return mod.label(mod.info()) === "2026.11.04 · abc1234+";
})());

/* ---------------- no environment, no git ---------------- */
/*
 * Saying "dev" is the point: a wrong commit is worse than an admitted unknown,
 * because the whole purpose is telling what is actually deployed.
 */
clearEnv();
v = load().info();
ok("without an environment it still produces something", !!v.version && !!v.sha);
ok("the commit is either real or honestly 'dev'",
   v.sha === "dev" || /^[0-9a-f]{7}$/.test(v.sha));
ok("the version always looks like a date", /^\d{4}\.\d{2}\.\d{2}$/.test(v.version));
restoreEnv();

/* ---------------- baked into the page ---------------- */

const page = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");

ok("the built page has a footer", page.includes("sitefoot"));
ok("the placeholder was replaced", !page.includes("__VERSION__"));
ok("the page carries a version object", /"version":"\d{4}\.\d{2}\.\d{2}"/.test(page));
ok("the page carries a commit", /"sha":"[0-9a-f]{7}"|"sha":"dev"/.test(page));
ok("the page knows where the source is", page.includes("github.com/fooxytv/cplus-talents"));

/* ---------------- the pieces that pass it through ---------------- */

const dockerfile = fs.readFileSync(path.join(ROOT, "Dockerfile"), "utf8");
ok("the image accepts the commit as a build argument", dockerfile.includes("ARG GIT_SHA"));
ok("and puts it in the environment build.js reads", dockerfile.includes("ENV GIT_SHA=$GIT_SHA"));

const simDockerfile = fs.readFileSync(path.join(ROOT, "sim", "Dockerfile"), "utf8");
ok("the sim image does the same", simDockerfile.includes("ARG GIT_SHA"));
ok("and carries version.js, which it requires at runtime",
   simDockerfile.includes("src/version.js"));

for (const f of ["docker-compose.yml", path.join("deploy", "docker-compose.yml")]) {
  const compose = fs.readFileSync(path.join(ROOT, f), "utf8");
  ok(`${f} passes the commit through`, compose.includes("GIT_SHA:"));
}

// Without this the arguments are never set and every build says "dev".
const update = fs.readFileSync(path.join(ROOT, "deploy", "update.sh"), "utf8");
ok("the deploy script works out the commit", update.includes("git rev-parse"));
ok("and exports it for the build", update.includes("export GIT_SHA"));
ok("and checks the running site is that commit", update.includes("/api/version"));

const build = fs.readFileSync(path.join(ROOT, "build.sh"), "utf8");
ok("the local build helper does the same", build.includes("git rev-parse"));

console.log(`\n  ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log("    FAIL  " + f);
  process.exit(1);
}
