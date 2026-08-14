import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CURRENT_SCHEMA_VERSION,
  MIGRATIONS,
  assertSchema,
  getSchemaVersion,
  migrateDb,
  openDb,
  setSchemaVersion,
  txImmediate,
} from "./db.mjs";
import { createIsolatedHome, realFactorySnapshot } from "../test-helpers.mjs";

const freshFile = () => path.join(mkdtempSync(path.join(os.tmpdir(), "evrt-db-")), "runtime.db");

describe("cold start (OPS-376, OPS-424)", () => {
  test("a second connection to a brand-new database does not fight for the WAL switch", () => {
    const file = freshFile();
    // The first open performs the switch; the second must find it already
    // done. Before OPS-376 the second raced for an exclusive lock that
    // busy_timeout does not cover, and one process died with SQLITE_BUSY —
    // exactly what serve and work did when worktree-up.sh started them together.
    const first = openDb(file);
    const second = openDb(file);
    expect(first.query("PRAGMA journal_mode").get().journal_mode).toBe("wal");
    expect(second.query("PRAGMA journal_mode").get().journal_mode).toBe("wal");
    // Both are usable, which is the property that actually matters.
    expect(second.query(`SELECT COUNT(*) AS n FROM events`).get().n).toBe(0);
    first.close();
    second.close();
  });

  test("many connections to one fresh database all open cleanly", () => {
    const file = freshFile();
    const connections = Array.from({ length: 8 }, () => openDb(file));
    for (const db of connections) {
      expect(db.query("PRAGMA journal_mode").get().journal_mode).toBe("wal");
    }
    for (const db of connections) db.close();
  });

  test("reopening an existing WAL database takes no exclusive lock", () => {
    const file = freshFile();
    const held = openDb(file); // stays open, holding the database
    const second = openDb(file); // would block on an exclusive switch
    expect(second.query("PRAGMA journal_mode").get().journal_mode).toBe("wal");
    held.close();
    second.close();
  });

  test("multi-process cold start: concurrent processes opening a brand-new database all reach WAL (OPS-424)", async () => {
    const file = freshFile();
    const N = 8;
    const procs = Array.from({ length: N }, () => {
      return Bun.spawn(
        [
          "bun",
          "-e",
          `
            import { openDb } from "./event-runtime/lib/db.mjs";
            const db = openDb(process.argv[1]);
            const mode = db.query("PRAGMA journal_mode").get()?.journal_mode;
            if (mode !== "wal") {
              console.error("expected WAL mode, got " + mode);
              process.exit(1);
            }
            const count = db.query("SELECT COUNT(*) AS n FROM events").get()?.n;
            if (count !== 0) {
              console.error("expected 0 events, got " + count);
              process.exit(1);
            }
            db.close();
          `,
          file,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
    });

    const results = await Promise.all(
      procs.map(async (p) => {
        const code = await p.exited;
        const err = await new Response(p.stderr).text();
        return { code, err };
      }),
    );

    for (const r of results) {
      expect(r.code).toBe(0);
      expect(r.err).toBe("");
    }

    const verifyDb = openDb(file);
    expect(verifyDb.query("PRAGMA journal_mode").get().journal_mode).toBe("wal");
    verifyDb.close();
  });
});

describe("synchronous mode (OPS-414)", () => {
  test("openDb sets synchronous = FULL (2) to guarantee durability on power loss", () => {
    const file = freshFile();
    const db = openDb(file);
    const syncMode = db.query("PRAGMA synchronous").get()?.synchronous;
    expect(syncMode).toBe(2); // 2 = FULL
    db.close();
  });
});

describe("schema migration runner and assertions (OPS-415)", () => {
  test("a fresh database is migrated to CURRENT_SCHEMA_VERSION on open", () => {
    const file = freshFile();
    const db = openDb(file);
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
    assertSchema(db);
    db.close();
  });

  test("an older/unversioned database (user_version 0) is migrated on open", () => {
    const file = freshFile();
    // Simulate an unversioned raw sqlite db
    const rawDb = new Database(file);
    expect(getSchemaVersion(rawDb)).toBe(0);
    rawDb.close();

    const db = openDb(file);
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
    expect(db.query("SELECT count(*) as count FROM events").get()?.count).toBe(0);
    db.close();
  });

  test("a database at a newer user_version refuses to open loudly with a clear message", () => {
    const file = freshFile();
    const db = openDb(file);
    setSchemaVersion(db, 999);
    db.close();

    expect(() => openDb(file)).toThrow(
      "Database schema version (999) is newer than code version (1). Please upgrade the runtime.",
    );
  });

  test("adding a column in a migration works against an existing populated database fixture", () => {
    const file = freshFile();
    const db = openDb(file);

    // Populate with existing event fixture
    db.query(
      `INSERT INTO events (source, event_id, type, occurred_at, received_at, envelope_json, payload_hash, admitted_at)
       VALUES ('github', 'evt-415', 'issue.opened', '2026-08-14T00:00:00Z', '2026-08-14T00:00:01Z', '{}', 'hash1', '2026-08-14T00:00:01Z')`,
    ).run();

    expect(getSchemaVersion(db)).toBe(1);

    // Apply a custom migration v2 that adds a column
    const migrationsV2 = [
      MIGRATIONS[0],
      {
        version: 2,
        name: "add_priority_to_events",
        up(targetDb) {
          targetDb.exec("ALTER TABLE events ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal';");
        },
      },
    ];

    migrateDb(db, { migrations: migrationsV2, targetVersion: 2 });
    expect(getSchemaVersion(db)).toBe(2);

    // Verify existing row is preserved and has default value
    const row = db.query("SELECT event_id, priority FROM events WHERE event_id = 'evt-415'").get();
    expect(row.event_id).toBe("evt-415");
    expect(row.priority).toBe("normal");

    // Verify we can write with the new column
    db.query(
      `INSERT INTO events (source, event_id, type, occurred_at, received_at, envelope_json, payload_hash, admitted_at, priority)
       VALUES ('github', 'evt-416', 'issue.closed', '2026-08-14T00:01:00Z', '2026-08-14T00:01:01Z', '{}', 'hash2', '2026-08-14T00:01:01Z', 'urgent')`,
    ).run();

    const row2 = db.query("SELECT event_id, priority FROM events WHERE event_id = 'evt-416'").get();
    expect(row2.priority).toBe("urgent");

    db.close();
  });

  test("startup schema assertion catches drift / missing table", () => {
    const file = freshFile();
    const db = openDb(file);
    db.exec("DROP TABLE counters;");
    expect(() => assertSchema(db)).toThrow('Database schema drift detected: missing table "counters"');
    db.close();
  });

  test("startup schema assertion catches user_version mismatch", () => {
    const file = freshFile();
    const db = openDb(file);
    setSchemaVersion(db, 0);
    expect(() => assertSchema(db)).toThrow("Database schema assertion failed: user_version is 0, expected 1");
    db.close();
  });
});

describe("txImmediate (OPS-233)", () => {
  test("commits like a normal transaction and rolls back on throw", () => {
    const db = openDb(freshFile());
    txImmediate(db, () => {
      db.query(`INSERT INTO counters (name, value) VALUES ('x', 1)`).run();
    });
    expect(db.query(`SELECT value FROM counters WHERE name = 'x'`).get().value).toBe(1);

    expect(() =>
      txImmediate(db, () => {
        db.query(`UPDATE counters SET value = 99 WHERE name = 'x'`).run();
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(db.query(`SELECT value FROM counters WHERE name = 'x'`).get().value).toBe(1);
    db.close();
  });
});

describe("hermetic execution guard (OPS-425)", () => {
  test("isolated home directories never mutate the operator's real ~/.factory", () => {
    const before = realFactorySnapshot();
    const isolated = createIsolatedHome("evrt-guard-test-");
    const testDbPath = path.join(isolated, "runtime.db");
    const db = openDb(testDbPath);
    db.query(`INSERT INTO counters (name, value) VALUES ('guard', 42)`).run();
    expect(db.query(`SELECT value FROM counters WHERE name = 'guard'`).get().value).toBe(42);
    db.close();
    const after = realFactorySnapshot();
    if (before.exists && after.exists) {
      expect(after.mtime).toBe(before.mtime);
    }
  });
});
