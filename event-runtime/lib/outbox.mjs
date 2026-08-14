/**
 * Outbox delivery (docs/event-runtime.md §8, §15).
 *
 * Result events are written to the outbox in the same transaction as the
 * accepted result; delivery happens afterwards, at least once. The MVP's only
 * sink is the watched operator terminal — §15: the output is displayed and
 * causes no further action. A row is stamped published only after its sink
 * call returns, so a sink crash re-delivers rather than drops.
 */
import { tx } from "./db.mjs";

/**
 * Deliver every unpublished outbox event to `sink(envelope, row)` in insertion
 * order, stamping each row after a successful delivery. Stops at the first
 * sink failure (order preserved for the retry).
 *
 * @returns {number} rows delivered
 */
export function publishOutbox(db, { sink, now = Date.now() } = {}) {
  const rows = db
    .query(`SELECT seq, event_json FROM outbox WHERE published_at IS NULL ORDER BY seq`)
    .all();
  let delivered = 0;
  for (const row of rows) {
    sink(JSON.parse(row.event_json), row);
    tx(db, () => {
      db.query(`UPDATE outbox SET published_at = ? WHERE seq = ?`).run(new Date(now).toISOString(), row.seq);
    });
    delivered += 1;
  }
  return delivered;
}
