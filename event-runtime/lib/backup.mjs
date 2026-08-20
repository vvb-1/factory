/**
 * WAL-safe SQLite database backup, restore, and integrity checks (docs/event-runtime.md §10).
 *
 * The event runtime ledger is authoritative for webhook and event admissions.
 * Under WAL mode, a naive file copy of `runtime.db` can miss active, uncheckpointed
 * WAL frames in `runtime.db-wal` (or produce a corrupt read if copied during an
 * active write).
 *
 * SQLite's `VACUUM INTO` takes a shared read lock, checkpoints all in-flight WAL
 * pages into a new standalone database file, and guarantees that the resulting
 * snapshot is consistent and self-contained without needing separate WAL files.
 */
import { Database } from "bun:sqlite";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { artifactsRoot, dbPath as defaultDbPath } from "./config.mjs";

/**
 * Check SQLite database integrity using `PRAGMA integrity_check`.
 *
 * @param {Database|string} dbOrPath - Database instance or path to .db file
 * @param {{ throwOnError?: boolean }} options
 * @returns {{ ok: boolean, result: string, errors: string[] }}
 */
export function checkIntegrity(dbOrPath, { throwOnError = false } = {}) {
  let db = null;
  let shouldClose = false;

  try {
    if (typeof dbOrPath === "string") {
      if (!existsSync(dbOrPath)) {
        const msg = `integrity check failed: file does not exist: ${dbOrPath}`;
        if (throwOnError) throw new Error(msg);
        return { ok: false, result: "missing_file", errors: [msg] };
      }
      db = new Database(dbOrPath, { readonly: true });
      shouldClose = true;
    } else {
      db = dbOrPath;
    }

    const rows = db.query("PRAGMA integrity_check;").all();
    const errors = [];
    let isOk = true;

    for (const row of rows) {
      const val = row?.integrity_check ?? Object.values(row)[0];
      if (val !== "ok") {
        isOk = false;
        errors.push(String(val));
      }
    }

    if (!isOk) {
      const msg = `SQLite integrity check failed:\n${errors.join("\n")}`;
      if (throwOnError) throw new Error(msg);
      return { ok: false, result: "corrupt", errors };
    }

    return { ok: true, result: "ok", errors: [] };
  } catch (err) {
    if (throwOnError) throw err;
    return { ok: false, result: "error", errors: [err.message] };
  } finally {
    if (shouldClose && db) {
      db.close();
    }
  }
}

/**
 * Create a WAL-safe, consistent SQLite database backup using `VACUUM INTO`.
 *
 * Writes to a temporary file, verifies integrity, and atomically moves to
 * `destinationPath`.
 *
 * @param {Database|string} dbOrPath - Active Database instance or path to runtime.db
 * @param {string} destinationPath - Target backup file path
 * @param {{ overwrite?: boolean }} options
 * @returns {{ destinationPath: string, sizeBytes: number, backupTime: string, integrity: string }}
 */
export function backupDatabase(
  dbOrPath,
  destinationPath,
  { overwrite = true } = {},
) {
  let db = null;
  let shouldClose = false;

  try {
    if (typeof dbOrPath === "string") {
      if (!existsSync(dbOrPath)) {
        throw new Error(
          `cannot backup database: source file does not exist: ${dbOrPath}`,
        );
      }
      db = new Database(dbOrPath);
      shouldClose = true;
    } else {
      db = dbOrPath;
    }

    const destDir = path.dirname(destinationPath);
    mkdirSync(destDir, { recursive: true });

    const nonce = crypto.randomBytes(6).toString("hex");
    const tmpDest = path.join(
      destDir,
      `.${path.basename(destinationPath)}.tmp-${Date.now()}-${nonce}`,
    );

    // Clean up any stale temp file with the same name
    if (existsSync(tmpDest)) unlinkSync(tmpDest);

    // VACUUM INTO safely checkpoints in-memory and WAL state into a standalone database
    db.query("VACUUM INTO ?").run(tmpDest);

    // Verify integrity of the newly produced snapshot before promoting it
    const check = checkIntegrity(tmpDest);
    if (!check.ok) {
      if (existsSync(tmpDest)) unlinkSync(tmpDest);
      throw new Error(`backup verification failed: ${check.errors.join("; ")}`);
    }

    if (existsSync(destinationPath)) {
      if (!overwrite) {
        if (existsSync(tmpDest)) unlinkSync(tmpDest);
        throw new Error(
          `destination file already exists and overwrite is false: ${destinationPath}`,
        );
      }
      unlinkSync(destinationPath);
    }

    renameSync(tmpDest, destinationPath);
    const stat = statSync(destinationPath);

    return {
      destinationPath,
      sizeBytes: stat.size,
      backupTime: new Date().toISOString(),
      integrity: "ok",
    };
  } finally {
    if (shouldClose && db) {
      db.close();
    }
  }
}

/**
 * Restore database from a backup file to `targetDbPath`.
 *
 * Verifies backup integrity before modifying the target. Removes stale `-wal`
 * and `-shm` files to prevent corrupted WAL replay.
 *
 * @param {string} backupPath - Path to valid backup .db file
 * @param {string} [targetDbPath] - Path to restore to (defaults to runtime dbPath)
 * @returns {{ restored: true, targetDbPath: string, sizeBytes: number }}
 */
export function restoreDatabase(backupPath, targetDbPath = defaultDbPath()) {
  if (!existsSync(backupPath)) {
    throw new Error(
      `cannot restore database: backup file not found: ${backupPath}`,
    );
  }

  // 1. Verify backup file integrity
  const check = checkIntegrity(backupPath);
  if (!check.ok) {
    throw new Error(
      `cannot restore database: backup file is corrupt: ${check.errors.join("; ")}`,
    );
  }

  const targetDir = path.dirname(targetDbPath);
  mkdirSync(targetDir, { recursive: true });

  // 2. Remove target db and any stale WAL/SHM companion files
  const walPath = `${targetDbPath}-wal`;
  const shmPath = `${targetDbPath}-shm`;

  if (existsSync(targetDbPath)) unlinkSync(targetDbPath);
  if (existsSync(walPath)) unlinkSync(walPath);
  if (existsSync(shmPath)) unlinkSync(shmPath);

  // 3. Copy backup file to target
  copyFileSync(backupPath, targetDbPath);

  // 4. Verify restored target database
  const restoredCheck = checkIntegrity(targetDbPath);
  if (!restoredCheck.ok) {
    throw new Error(
      `restored database integrity check failed: ${restoredCheck.errors.join("; ")}`,
    );
  }

  const stat = statSync(targetDbPath);
  return {
    restored: true,
    targetDbPath,
    sizeBytes: stat.size,
  };
}

/**
 * Snapshot artifacts store to backup directory.
 *
 * @param {string} [sourceDir] - Artifacts root (defaults to artifactsRoot())
 * @param {string} destinationDir - Destination directory
 * @returns {{ copiedFiles: number, totalBytes: number }}
 */
export function backupArtifacts(sourceDir = artifactsRoot(), destinationDir) {
  if (!existsSync(sourceDir)) {
    mkdirSync(destinationDir, { recursive: true });
    return { copiedFiles: 0, totalBytes: 0 };
  }

  mkdirSync(destinationDir, { recursive: true });
  cpSync(sourceDir, destinationDir, { recursive: true });

  let count = 0;
  let bytes = 0;
  function scan(dir) {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        scan(full);
      } else if (ent.isFile()) {
        count += 1;
        bytes += statSync(full).size;
      }
    }
  }
  scan(destinationDir);

  return { copiedFiles: count, totalBytes: bytes };
}

/**
 * Create a full ledger snapshot including WAL-safe SQLite database and artifacts store.
 *
 * @param {{
 *   db?: Database,
 *   dbPath?: string,
 *   artifactsDir?: string,
 *   backupDir: string,
 *   snapshotName?: string
 * }} options
 */
export function snapshotLedger({
  db,
  dbPath: srcDbPath = defaultDbPath(),
  artifactsDir = artifactsRoot(),
  backupDir,
  snapshotName = `snapshot-${Date.now()}`,
} = {}) {
  const snapshotPath = path.join(backupDir, snapshotName);
  mkdirSync(snapshotPath, { recursive: true });

  const destDb = path.join(snapshotPath, "runtime.db");
  const dbBackup = backupDatabase(db ?? srcDbPath, destDb);

  const destArtifacts = path.join(snapshotPath, "artifacts");
  const artifactsBackup = backupArtifacts(artifactsDir, destArtifacts);

  return {
    snapshotPath,
    dbBackup,
    artifactsBackup,
    snapshotTime: new Date().toISOString(),
  };
}
