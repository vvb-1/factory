/**
 * Live agent trace (factory.trace/v1) — what the agent is doing *right now*.
 *
 * The lifecycle journal (§8) answers "what state is the run in"; the trace
 * answers "what is the model saying and which tools is it calling" while the
 * run is still RUNNING. Rows are append-only in `attempt_trace`, attributed
 * to (run, attempt), and read back through `GET /runs/:id/trace` — never by
 * clients touching the database (§12).
 *
 * The trace is adapter-supplied and therefore agent-influenced, so it is
 * treated as untrusted input under the §14 size rules: a closed kind set,
 * a per-event payload byte bound, and a hard per-attempt row cap. Nothing
 * the agent streams may crash the worker or grow the database without limit
 * — the recorder drops, truncates, and counts instead of throwing.
 */

/** Closed kind set (factory.trace/v1). Anything else is dropped, counted. */
export const TRACE_KINDS = ["assistant_text", "tool_use", "tool_result", "usage", "lifecycle"];

/** Hard per-attempt row cap (§14 size bound): after this, one marker row. */
export const TRACE_EVENTS_CAP = 2000;

/** Per-event payload bound: canonical JSON above this is truncated in place. */
export const TRACE_PAYLOAD_MAX_BYTES = 16 * 1024;

/** How much of an oversize payload survives inside the truncation marker. */
const TRUNCATED_PREVIEW_CHARS = 4096;

/**
 * Build a per-attempt trace recorder.
 *
 * Returns `record(kind, payload)` which never throws: unknown kinds and
 * unserializable payloads are dropped (and counted), oversize payloads are
 * replaced by `{ truncated: true, preview, originalBytes }`, and once
 * TRACE_EVENTS_CAP rows exist exactly one final `lifecycle` row
 * `{ note: "trace_truncated", dropped }` is written and everything after it
 * is ignored. `record.stats()` reports `{ recorded, dropped }`.
 *
 * @param {import("bun:sqlite").Database} db
 * @param {{ runId: string, attempt: number, now?: () => number }} opts
 */
export function traceRecorder(db, { runId, attempt, now = () => Date.now() }) {
  const insert = db.query(
    `INSERT INTO attempt_trace (run_id, attempt, ts, kind, payload_json) VALUES (?, ?, ?, ?, ?)`,
  );
  let recorded = 0;
  let dropped = 0;
  let capped = false; // the single truncation marker has been written

  function record(kind, payload) {
    try {
      if (!TRACE_KINDS.includes(kind)) {
        dropped += 1;
        return;
      }
      if (capped) {
        dropped += 1;
        return;
      }
      if (recorded >= TRACE_EVENTS_CAP) {
        // The cap is hit: this event is dropped, and exactly one marker row
        // records that the trace is incomplete. Idempotent via `capped`.
        capped = true;
        dropped += 1;
        insert.run(
          runId, attempt, new Date(now()).toISOString(), "lifecycle",
          JSON.stringify({ note: "trace_truncated", dropped }),
        );
        return;
      }
      let json = JSON.stringify(payload ?? null);
      if (json === undefined) json = "null"; // e.g. a bare function slipped in
      if (Buffer.byteLength(json, "utf8") > TRACE_PAYLOAD_MAX_BYTES) {
        json = JSON.stringify({
          truncated: true,
          preview: json.slice(0, TRUNCATED_PREVIEW_CHARS),
          originalBytes: Buffer.byteLength(json, "utf8"),
        });
      }
      insert.run(runId, attempt, new Date(now()).toISOString(), kind, json);
      recorded += 1;
    } catch {
      // A trace failure must never surface into the attempt (§14): count it.
      dropped += 1;
    }
  }

  record.stats = () => ({ recorded, dropped });
  return record;
}

/**
 * Read a run's trace, ascending by seq, for incremental polling: `head` is
 * the max seq recorded *for that run* (0 when none), so a client passes it
 * back as `since` and receives only new rows. `limit` is capped at 500.
 *
 * @returns {{ head: number, entries: Array<{seq: number, attempt: number, ts: string, kind: string, payload: unknown}> }}
 */
export function traceOf(db, runId, { since = 0, limit = 100 } = {}) {
  const from = Number.isFinite(since) ? since : 0;
  const cap = Math.min(Math.max(Number.isFinite(limit) ? limit : 100, 0), 500);
  const head = db
    .query(`SELECT MAX(seq) AS m FROM attempt_trace WHERE run_id = ?`)
    .get(runId).m ?? 0;
  const rows = db
    .query(
      `SELECT seq, attempt, ts, kind, payload_json FROM attempt_trace
       WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT ?`,
    )
    .all(runId, from, cap);
  return {
    head,
    entries: rows.map((row) => ({
      seq: row.seq,
      attempt: row.attempt,
      ts: row.ts,
      kind: row.kind,
      payload: JSON.parse(row.payload_json),
    })),
  };
}
