"use strict";
/**
 * What version is this, and which commit built it?
 *
 * The number lives in the VERSION file at the repo root - edit it to bump.
 * Everything else is worked out.
 *
 * Two places need the answer and neither can rely on the other's environment:
 *
 *  - Running from a clone, git is right there and knows everything.
 *  - Inside the image, it is not: .dockerignore excludes .git on purpose, so
 *    the build never carries a copy of the history. The Dockerfile passes the
 *    values in as build arguments instead, and they arrive as environment
 *    variables.
 *
 * So: ask the environment first, fall back to git, and say "dev" rather than
 * guessing. A wrong commit is worse than an admitted unknown - the whole point
 * is being able to tell what is deployed.
 */

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const REPO = "https://github.com/fooxytv/cplus-talents";
const SEMVER = /^\d+\.\d+\.\d+$/;
const FALLBACK = "0.0.0";

function fromGit(args) {
  try {
    return execFileSync("git", args, {
      cwd: __dirname,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch (e) {
    return "";                       // no git, or not a clone: not an error
  }
}

/** The number from VERSION, refusing anything that is not semver. */
function semver() {
  const file = path.join(__dirname, "..", "VERSION");
  let raw = "";
  try { raw = fs.readFileSync(file, "utf8").trim(); } catch (e) { return FALLBACK; }
  // A malformed VERSION would otherwise ship a version string that is not one,
  // and the point of the footer is that it can be trusted.
  return SEMVER.test(raw) ? raw : FALLBACK;
}

function info() {
  const sha = (process.env.GIT_SHA || fromGit(["rev-parse", "--short=7", "HEAD"]) || "").trim();
  const built = (process.env.BUILD_TIME || new Date().toISOString()).trim();

  // A working tree with uncommitted changes is not the commit it claims to be,
  // and saying so has saved more time than it has ever cost. Marked "-dirty"
  // rather than "+", because "+" means build metadata in semver and would read
  // as part of the version.
  const dirty = process.env.GIT_DIRTY === "1" ||
    (!process.env.GIT_SHA && fromGit(["status", "--porcelain"]).length > 0);

  const commitDate = (process.env.GIT_DATE || fromGit(["log", "-1", "--format=%cs"]) ||
    built.slice(0, 10)).trim();

  const version = semver();
  const id = `${version}.${sha || "dev"}${dirty ? "-dirty" : ""}`;

  return {
    version,                         // 0.1.0
    sha: sha || "dev",               // 167b0a6
    dirty: !!dirty,
    id,                              // 0.1.0.167b0a6
    commitDate,
    built,
    repo: REPO,
    commitUrl: sha ? `${REPO}/commit/${sha}` : REPO,
  };
}

/** "v0.1.0.167b0a6" - what the footer shows. */
function label(v) {
  return "v" + (v || info()).id;
}

module.exports = { info, label, semver, REPO, SEMVER };
