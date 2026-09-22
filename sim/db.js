"use strict";
/**
 * Storage for a race.
 *
 * `events` is append-only and is the record of what happened. Nothing ever
 * rewrites it - that is the whole reason this is a database and not a function
 * of the clock. Retune the model mid-race and the past stays as it was lived;
 * only what happens next changes.
 *
 * `bot_state` is a cache of replaying the events, kept so the leaderboard is
 * one cheap query rather than a fold over a million rows.
 */

const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

function open(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS races (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      edition    TEXT NOT NULL,
      seed       INTEGER NOT NULL,
      hardcore   INTEGER NOT NULL DEFAULT 0,
      minutes    INTEGER NOT NULL DEFAULT 0,
      status     TEXT NOT NULL DEFAULT 'running',
      created_at TEXT NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS bots (
      race_id TEXT NOT NULL,
      id      TEXT NOT NULL,
      name    TEXT NOT NULL,
      klass   TEXT NOT NULL,
      spec    TEXT NOT NULL,
      seed    INTEGER NOT NULL,
      route   TEXT NOT NULL,
      bias    TEXT NOT NULL,
      PRIMARY KEY (race_id, id)
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      race_id    TEXT NOT NULL,
      bot_id     TEXT NOT NULL,
      at_minutes INTEGER NOT NULL,
      type       TEXT NOT NULL,
      level      INTEGER NOT NULL,
      detail     TEXT NOT NULL DEFAULT '{}'
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS events_race ON events (race_id, id DESC)");
  db.exec("CREATE INDEX IF NOT EXISTS events_bot ON events (race_id, bot_id, id)");

  db.exec(`
    CREATE TABLE IF NOT EXISTS bot_state (
      race_id        TEXT NOT NULL,
      bot_id         TEXT NOT NULL,
      level          INTEGER NOT NULL,
      xp             REAL NOT NULL,
      step           INTEGER NOT NULL,
      deaths         INTEGER NOT NULL,
      alive          INTEGER NOT NULL,
      played_minutes INTEGER NOT NULL,
      finished_at    INTEGER,
      PRIMARY KEY (race_id, bot_id)
    )
  `);

  return db;
}

function statements(db) {
  return {
    createRace: db.prepare(`INSERT INTO races (id, name, edition, seed, hardcore, minutes, status, created_at)
                            VALUES (?, ?, ?, ?, ?, 0, 'running', ?)`),
    setMinutes: db.prepare("UPDATE races SET minutes = ?, status = ? WHERE id = ?"),
    getRace: db.prepare("SELECT * FROM races WHERE id = ?"),
    listRaces: db.prepare("SELECT * FROM races ORDER BY created_at DESC LIMIT ?"),

    addBot: db.prepare(`INSERT INTO bots (race_id, id, name, klass, spec, seed, route, bias)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
    listBots: db.prepare("SELECT * FROM bots WHERE race_id = ?"),

    addEvent: db.prepare(`INSERT INTO events (race_id, bot_id, at_minutes, type, level, detail)
                          VALUES (?, ?, ?, ?, ?, ?)`),
    feed: db.prepare(`SELECT e.*, b.name FROM events e JOIN bots b
                      ON b.race_id = e.race_id AND b.id = e.bot_id
                      WHERE e.race_id = ? AND e.type IN ('ding','death','finish')
                      ORDER BY e.id DESC LIMIT ?`),

    putState: db.prepare(`INSERT INTO bot_state
      (race_id, bot_id, level, xp, step, deaths, alive, played_minutes, finished_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (race_id, bot_id) DO UPDATE SET
        level = excluded.level, xp = excluded.xp, step = excluded.step,
        deaths = excluded.deaths, alive = excluded.alive,
        played_minutes = excluded.played_minutes, finished_at = excluded.finished_at`),

    board: db.prepare(`SELECT s.*, b.name, b.klass, b.spec FROM bot_state s
                       JOIN bots b ON b.race_id = s.race_id AND b.id = s.bot_id
                       WHERE s.race_id = ?
                       ORDER BY (s.finished_at IS NULL), s.finished_at,
                                s.level DESC, s.xp DESC`),
  };
}

module.exports = { open, statements };
