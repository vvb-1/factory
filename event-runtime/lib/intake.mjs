/**
 * Authenticated event intake (docs/event-runtime.md §5.1, §14).
 *
 * The webhook boundary is the runtime's outermost trust surface, so both
 * functions fail closed: a missing secret, missing header, stale timestamp,
 * or malformed anything is a typed refusal, never an exception and never an
 * admission. Verification runs over the raw body bytes before parsing, and
 * admission dedupes on (source, eventId) so an at-least-once delivery can
 * only ever produce one admitted row — a retry gets the original record back.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { canonicalJson, hashJson } from "./canonical.mjs";
import { TIMESTAMP_TOLERANCE_MS } from "./config.mjs";
import { tx, txImmediate } from "./db.mjs";
import { validate } from "./schema.mjs";

/** ISO-8601 or epoch-millis string → epoch millis, or null when unparseable. */
function parseTimestamp(value) {
  if (/^\d+$/.test(value)) return Number(value);
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Verify `signature` = "sha256=<hex>" where <hex> is
 * HMAC-SHA256(secret, `${timestamp}.${rawBody}`). Fail closed on anything
 * missing or malformed; never throws on bad input.
 *
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function verifyWebhook({ rawBody, signature, timestamp, secret, now = Date.now(), toleranceMs = TIMESTAMP_TOLERANCE_MS }) {
  if (!secret) return { ok: false, reason: "missing_secret" };
  if (!signature || typeof signature !== "string") return { ok: false, reason: "missing_signature" };
  if (timestamp === undefined || timestamp === null || timestamp === "") {
    return { ok: false, reason: "missing_timestamp" };
  }
  const timestampString = String(timestamp);
  const ts = parseTimestamp(timestampString);
  if (ts === null || Math.abs(now - ts) > toleranceMs) return { ok: false, reason: "stale_timestamp" };
  if (!signature.startsWith("sha256=")) return { ok: false, reason: "bad_signature" };
  try {
    const presented = Buffer.from(signature.slice("sha256=".length).toLowerCase(), "utf8");
    const expected = Buffer.from(
      createHmac("sha256", secret)
        .update(`${timestampString}.`)
        .update(rawBody ?? "")
        .digest("hex"),
      "utf8",
    );
    if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
      return { ok: false, reason: "bad_signature" };
    }
  } catch {
    return { ok: false, reason: "bad_signature" };
  }
  return { ok: true };
}

/**
 * Persist an already-authenticated envelope. Validates against the registered
 * envelope schema (fail closed), overwrites `receivedAt` with the server
 * clock — the sender's claim is never trusted — and dedupes on the
 * (source, eventId) primary key inside one transaction.
 *
 * @returns {{ admitted: true, duplicate: false, event: object }
 *         | { admitted: false, duplicate: true, event: object }
 *         | { admitted: false, duplicate: false, errors: string[] }}
 */
export function admitEvent(db, registry, envelope, { now = Date.now() } = {}) {
  if (envelope === null || typeof envelope !== "object" || Array.isArray(envelope)) {
    return { admitted: false, duplicate: false, errors: ["$: envelope must be an object"] };
  }
  const nowMs = typeof now === "number" ? now : (typeof now === "string" ? Date.parse(now) : Date.now());
  const receivedAt = new Date(nowMs).toISOString();
  const stored = { ...envelope, receivedAt };
  const { valid, errors } = validate(registry.schemas.envelope, stored);
  if (!valid) return { admitted: false, duplicate: false, errors };

  // Refuse clock tick events whose slot is in the future relative to now (OPS-437).
  if (stored.source === "schedule" || (typeof stored.type === "string" && stored.type.startsWith("clock.tick."))) {
    const occurredMs = Date.parse(stored.occurredAt);
    if (!Number.isNaN(occurredMs) && occurredMs > nowMs) {
      return { admitted: false, duplicate: false, errors: ["occurredAt: clock tick slot cannot be in the future"] };
    }
  }

  return txImmediate(db, () => {
    const existing = db
      .query(`SELECT * FROM events WHERE source = ? AND event_id = ?`)
      .get(stored.source, stored.eventId);
    if (existing) return { admitted: false, duplicate: true, event: existing };
    db.query(
      `INSERT INTO events
         (source, event_id, type, subject, occurred_at, received_at,
          correlation_id, causation_id, envelope_json, payload_hash, status, admitted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'admitted', ?)`,
    ).run(
      stored.source, stored.eventId, stored.type, stored.subject ?? null,
      stored.occurredAt, receivedAt, stored.correlationId ?? null, stored.causationId ?? null,
      canonicalJson(stored), hashJson(stored.payload), receivedAt,
    );
    const event = db
      .query(`SELECT * FROM events WHERE source = ? AND event_id = ?`)
      .get(stored.source, stored.eventId);
    return { admitted: true, duplicate: false, event };
  });
}
