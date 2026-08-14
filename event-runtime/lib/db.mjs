/**
 * SQLite substrate for the event runtime (docs/event-runtime.md §10).
 *
 * One embedded database holds the whole operational model: admitted events,
 * proposals, immutable run specs, attempts and leases, the append-only
 * lifecycle journal, accepted results, and the transactional outbox. This is
 * a deliberate departure from the orchestrator's stateless model — a webhook,
 * unlike a Linear ticket, cannot be re-read after delivery. The ledger is
 * authoritative for event facts only; Linear stays authoritative for work.
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { dbPath } from "./config.mjs";

export const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS events (
  source          TEXT NOT NULL,
  event_id        TEXT NOT NULL,
  type            TEXT NOT NULL,
  subject         TEXT,
  occurred_at     TEXT NOT NULL,
  received_at     TEXT NOT NULL,
  correlation_id  TEXT,
  causation_id    TEXT,
  envelope_json   TEXT NOT NULL,
  payload_hash    TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'admitted',
  plan_failures   INTEGER NOT NULL DEFAULT 0,
  last_plan_error TEXT,
  admitted_at     TEXT NOT NULL,
  PRIMARY KEY (source, event_id)
);

CREATE TABLE IF NOT EXISTS proposals (
  id              TEXT PRIMARY KEY,
  event_source    TEXT NOT NULL,
  event_id        TEXT NOT NULL,
  run_id          TEXT,
  decision        TEXT NOT NULL,
  spec_json       TEXT,
  spec_hash       TEXT,
  idempotency_key TEXT,
  status          TEXT NOT NULL DEFAULT 'open',
  reason          TEXT,
  created_at      TEXT NOT NULL,
  ttl_seconds     INTEGER NOT NULL,
  decided_at      TEXT,
  decided_by      TEXT
);

CREATE TABLE IF NOT EXISTS runs (
  run_id          TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  spec_json       TEXT NOT NULL,
  spec_hash       TEXT NOT NULL,
  state           TEXT NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS attempts (
  run_id           TEXT NOT NULL,
  attempt          INTEGER NOT NULL,
  fencing_token    INTEGER NOT NULL,
  lease_owner      TEXT,
  lease_expires_at TEXT,
  started_at       TEXT,
  finished_at      TEXT,
  terminal_state   TEXT,
  reason_code      TEXT,
  workspace_path   TEXT,
  PRIMARY KEY (run_id, attempt)
);

CREATE TABLE IF NOT EXISTS lifecycle_events (
  seq            INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id         TEXT NOT NULL,
  from_state     TEXT,
  to_state       TEXT NOT NULL,
  actor          TEXT NOT NULL,
  reason         TEXT,
  attempt        INTEGER,
  correlation_id TEXT,
  causation_id   TEXT,
  policy_version TEXT,
  at             TEXT NOT NULL,
  record_hash    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS results (
  run_id            TEXT NOT NULL,
  attempt           INTEGER NOT NULL,
  result_json       TEXT NOT NULL,
  artifact_hash     TEXT NOT NULL,
  evidence_set_hash TEXT,
  verification_json TEXT NOT NULL,
  receipt_json      TEXT NOT NULL,
  accepted_at       TEXT NOT NULL,
  PRIMARY KEY (run_id, attempt)
);

CREATE TABLE IF NOT EXISTS outbox (
  seq           INTEGER PRIMARY KEY AUTOINCREMENT,
  event_json    TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  published_at  TEXT
);

CREATE TABLE IF NOT EXISTS workers (
  worker_id   TEXT PRIMARY KEY,
  host        TEXT NOT NULL,
  pid         INTEGER NOT NULL,
  labels_json TEXT NOT NULL DEFAULT '{}',
  adapters    TEXT NOT NULL DEFAULT '',
  started_at  TEXT NOT NULL,
  last_seen   TEXT NOT NULL,
  state       TEXT NOT NULL DEFAULT 'idle',
  current_run TEXT,
  stopped_at  TEXT
);

CREATE TABLE IF NOT EXISTS counters (
  name  TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS attempt_trace (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id       TEXT NOT NULL,
  attempt      INTEGER NOT NULL,
  ts           TEXT NOT NULL,
  kind         TEXT NOT NULL,
  payload_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_runs_state ON runs (state);
CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals (status);
CREATE INDEX IF NOT EXISTS idx_lifecycle_run ON lifecycle_events (run_id, seq);
CREATE INDEX IF NOT EXISTS idx_workers_last_seen ON workers (last_seen);
CREATE INDEX IF NOT EXISTS idx_attempt_trace_run ON attempt_trace (run_id, seq);
`;

const SCHEMA = SCHEMA_V1;

/**
 * Ordered linear migrations list. Each migration runs sequentially inside a
 * transaction and advances PRAGMA user_version.
 */
export const MIGRATIONS = [
  {
    version: 1,
    name: "initial_schema",
    up(db) {
      db.exec(SCHEMA_V1);
    },
  },
];

export const CURRENT_SCHEMA_VERSION = MIGRATIONS.length > 0 ? MIGRATIONS[MIGRATIONS.length - 1].version : 1;

export const CORE_TABLES = [
  "events",
  "proposals",
  "runs",
  "attempts",
  "lifecycle_events",
  "results",
  "outbox",
  "workers",
  "counters",
  "attempt_trace",
];

/** Read current database schema version from PRAGMA user_version. */
export function getSchemaVersion(db) {
  return db.query("PRAGMA user_version").get()?.user_version ?? 0;
}

/** Set database schema version via PRAGMA user_version. */
export function setSchemaVersion(db, version) {
  db.exec(`PRAGMA user_version = ${Number(version)};`);
}

/**
 * Run pending linear migrations up to `targetVersion` inside an immediate transaction.
 *
 * Fails loudly when the database's user_version is newer than the code knows,
 * preventing silent drift or query-time failures during runtime execution.
 */
export function migrateDb(db, { migrations = MIGRATIONS, targetVersion = CURRENT_SCHEMA_VERSION } = {}) {
  const currentVersion = getSchemaVersion(db);
  if (currentVersion > targetVersion) {
    const msg = `Database schema version (${currentVersion}) is newer than code version (${targetVersion}). Please upgrade the runtime.`;
    console.error(`FATAL: ${msg}`);
    throw new Error(msg);
  }
  if (currentVersion < targetVersion) {
    txImmediate(db, () => {
      for (const m of migrations) {
        if (m.version > currentVersion && m.version <= targetVersion) {
          m.up(db);
          setSchemaVersion(db, m.version);
        }
      }
    });
  }
}

/**
 * Assert that all required tables exist and user_version matches current code expectation.
 */
export function assertSchema(db, { expectedTables = CORE_TABLES, expectedVersion = CURRENT_SCHEMA_VERSION } = {}) {
  const tables = new Set(
    db
      .query("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => r.name),
  );
  for (const table of expectedTables) {
    if (!tables.has(table)) {
      throw new Error(`Database schema drift detected: missing table "${table}"`);
    }
  }
  const version = getSchemaVersion(db);
  if (version !== expectedVersion) {
    throw new Error(
      `Database schema assertion failed: user_version is ${version}, expected ${expectedVersion}`,
    );
  }
}

/**
 * Put the database in WAL, tolerating a cold-start race (OPS-376).
 *
 * Journal mode is persistent, so the steady state needs no lock at all — read
 * it first and skip the switch when it is already `wal`. Only the genuine
 * first-time switch needs momentary exclusive access, which `busy_timeout`
 * does NOT cover: two processes starting together against a brand-new file
 * (serve and work, as worktree-up.sh launches them) had one win and the other
 * die with SQLITE_BUSY. A bounded retry converges instead.
 */
function enableWal(db, { attempts = 20, waitMs = 50 } = {}) {
  for (let i = 0; i < attempts; i += 1) {
    if (db.query("PRAGMA journal_mode").get()?.journal_mode === "wal") return;
    try {
      db.exec("PRAGMA journal_mode = WAL;");
      return;
    } catch (err) {
      // Someone else is mid-switch; they will finish and the read above wins.
      if (i === attempts - 1) {
        throw new Error(
          `could not switch the database to WAL after ${attempts} attempts: ${err.message}`,
        );
      }
      Bun.sleepSync(waitMs);
    }
  }
}

export function openDb(file = dbPath()) {
  if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file, { create: true });
  // busy_timeout FIRST: switching journal modes takes a brief exclusive lock,
  // and a second process opening the database concurrently must wait for it
  // rather than failing with SQLITE_BUSY_RECOVERY. Ordering matters here —
  // observed live the moment serve and work became separate processes.
  db.exec("PRAGMA busy_timeout = 5000;");
  enableWal(db);
  // Set synchronous = FULL (OPS-414): under WAL mode, the default NORMAL only
  // fsyncs at checkpoint boundaries, which can lose recent committed transactions
  // on sudden OS crash or power loss. For an authoritative once-only event delivery
  // ledger that cannot be re-requested, synchronous=FULL ensures that every write
  // transaction is durably committed to disk.
  db.exec("PRAGMA synchronous = FULL;");
  db.exec("PRAGMA foreign_keys = ON;");
  migrateDb(db);
  assertSchema(db);
  return db;
}

/** Run `fn` inside one SQLite transaction; returns its result. */
export function tx(db, fn) {
  return db.transaction(fn)();
}

/**
 * A write transaction that takes its lock up front (OPS-233).
 *
 * SQLite's default DEFERRED transaction acquires a read lock first and only
 * upgrades on the first write — so two workers can both SELECT the same
 * QUEUED run before either writes, and one then loses the upgrade with
 * SQLITE_BUSY. BEGIN IMMEDIATE serializes claimants at the start, which is
 * what makes multi-process claiming correct on one machine. (Postgres uses
 * FOR UPDATE SKIP LOCKED for the same job when workers span hosts.)
 */
export function txImmediate(db, fn) {
  return db.transaction(fn).immediate();
}

/**
 * Test whether an error represents a transient SQLite lock collision
 * (SQLITE_BUSY / SQLITE_LOCKED) that is safe to retry.
 */
export function isBusyError(err) {
  if (!err) return false;
  if (err.code === "SQLITE_BUSY" || err.code === "SQLITE_LOCKED" || err.code === "SQLITE_BUSY_RECOVERY") return true;
  if (typeof err.errno === "number" && (err.errno === 5 || err.errno === 6)) return true;
  const msg = String(err.message ?? err);
  return /database is locked|database table is locked|resource temporarily unavailable|\bSQLITE_BUSY\b|\bSQLITE_LOCKED\b/i.test(msg);
}


/** Monotonic named counter — fencing tokens come from here (§8). */
export function nextCounter(db, name) {
  const row = db
    .query(
      `INSERT INTO counters (name, value) VALUES (?, 1)
       ON CONFLICT(name) DO UPDATE SET value = value + 1
       RETURNING value`,
    )
    .get(name);
  return row.value;
}
