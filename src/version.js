"use strict";
/**
 * What version is this, and which commit built it?
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
 * guessing. A wrong version number is worse than an honest absence - the whole
 * point is being able to tell what is deployed.
 */

const { execFileSync } = require("node:child_process");

const REPO = "https://github.com/fooxytv/cplus-talents";

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

function info() {
  const sha = (process.env.GIT_SHA || fromGit(["rev-parse", "--short=7", "HEAD"]) || "").trim();
  const built = (process.env.BUILD_TIME || new Date().toISOString()).trim();

  // A working tree with uncommitted changes is not the commit it claims to be,
  // and saying so has saved more time than it has ever cost.
  const dirty = process.env.GIT_DIRTY === "1" ||
    (!process.env.GIT_SHA && fromGit(["status", "--porcelain"]).length > 0);

  // Dates make a better version than a number nobody remembers to bump: the
  // question being answered is "how old is this", not "which release is it".
  const day = (process.env.GIT_DATE || fromGit(["log", "-1", "--format=%cs"]) ||
    built.slice(0, 10)).trim();

  return {
    version: day.replace(/-/g, "."),
    sha: sha || "dev",
    dirty: !!dirty,
    built,
    repo: REPO,
    commitUrl: sha ? `${REPO}/commit/${sha}` : REPO,
  };
}

/** "2026.09.23 · 3afca8e" - what the footer shows. */
function label(v) {
  const i = v || info();
  return `${i.version} · ${i.sha}${i.dirty ? "+" : ""}`;
}

module.exports = { info, label, REPO };
