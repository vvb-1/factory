/**
 * Content-addressed artifact store (docs/event-runtime.md §7).
 *
 * The workspace is scratch state and dies with the run; a declared artifact
 * whose bytes died with it would be a hash that can never be re-read — the
 * same disease OPS-206 cured for evidence. At publish time the worker copies
 * every collected artifact into `<home>/artifacts/<sha256>`, keyed by content,
 * so identical bytes are stored once and a result row never references a file
 * that no longer exists.
 */
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HEX64 = /^[0-9a-f]{64}$/;

/** Resolve a store path from a content hash; malformed hashes fail closed. */
export function artifactPath(storeRoot, sha256hex) {
  if (!HEX64.test(sha256hex ?? "")) throw new Error(`invalid artifact hash: ${sha256hex}`);
  return path.join(storeRoot, sha256hex);
}

/**
 * Copy verified artifact entries out of the workspace into the store and
 * return the entries rewritten to their durable location (plus size). Must
 * run BEFORE the workspace is destroyed and before the result row commits —
 * an orphaned store file from a failed transaction is harmless (content-
 * addressed, re-usable); a committed row pointing at a dead file is not.
 */
export function storeCollected({ entries, storeRoot }) {
  if (!entries?.length) return entries ?? [];
  mkdirSync(storeRoot, { recursive: true });
  return entries.map((entry) => {
    const dest = artifactPath(storeRoot, entry.sha256);
    if (!existsSync(dest)) copyFileSync(fileURLToPath(entry.uri), dest);
    return { ...entry, uri: `file://${dest}`, sizeBytes: statSync(dest).size };
  });
}

/** Locate a stored artifact for serving; null when absent. */
export function findArtifact(storeRoot, sha256hex) {
  if (!HEX64.test(sha256hex ?? "")) return null;
  const file = path.join(storeRoot, sha256hex);
  if (!existsSync(file)) return null;
  return { file, sizeBytes: statSync(file).size };
}
