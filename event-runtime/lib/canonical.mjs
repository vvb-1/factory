/**
 * Canonical JSON and content hashes. Every deterministic identity in the
 * runtime — payload hashes, artifact hashes, spec hashes, lifecycle record
 * hashes — derives from these bytes (docs/event-runtime.md §9–§10), so key
 * order and formatting can never matter and two writers can never disagree
 * about the hash of the same value.
 */
import { createHash } from "node:crypto";

/**
 * Serialize with object keys sorted recursively. Undefined object properties
 * are dropped (as JSON.stringify does); undefined array elements and
 * non-finite numbers are errors rather than silent nulls.
 */
export function canonicalJson(value) {
  return JSON.stringify(sortValue(value, "$"));
}

function sortValue(value, path) {
  if (value === undefined) throw new TypeError(`undefined at ${path} is not representable in canonical JSON`);
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new TypeError(`non-finite number at ${path} is not representable in canonical JSON`);
    }
    if (typeof value === "bigint") throw new TypeError(`bigint at ${path} is not representable in canonical JSON`);
    return value;
  }
  if (Array.isArray(value)) return value.map((v, i) => sortValue(v, `${path}[${i}]`));
  const sorted = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] === undefined) continue;
    sorted[key] = sortValue(value[key], `${path}.${key}`);
  }
  return sorted;
}

export function sha256Hex(data) {
  return createHash("sha256").update(data).digest("hex");
}

export function hashBytes(data) {
  return `sha256:${sha256Hex(data)}`;
}

export function hashJson(value) {
  return hashBytes(canonicalJson(value));
}
