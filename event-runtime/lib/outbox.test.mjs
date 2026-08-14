import { describe, expect, test } from "bun:test";
import { openDb } from "./db.mjs";
import { publishOutbox } from "./outbox.mjs";

function seedOutbox(db, eventId) {
  db.query(`INSERT INTO outbox (event_json, created_at) VALUES (?, ?)`).run(
    JSON.stringify({ schemaVersion: "factory.event/v1", eventId, type: "t.completed", payload: {} }),
    new Date(0).toISOString(),
  );
}

describe("publishOutbox", () => {
  test("delivers unpublished rows in order and stamps them", () => {
    const db = openDb(":memory:");
    seedOutbox(db, "a");
    seedOutbox(db, "b");
    const seen = [];
    expect(publishOutbox(db, { sink: (e) => seen.push(e.eventId) })).toBe(2);
    expect(seen).toEqual(["a", "b"]);
    expect(publishOutbox(db, { sink: (e) => seen.push(e.eventId) })).toBe(0);
    expect(seen).toEqual(["a", "b"]);
  });

  test("a sink failure leaves the row unpublished for redelivery", () => {
    const db = openDb(":memory:");
    seedOutbox(db, "a");
    expect(() => publishOutbox(db, { sink: () => { throw new Error("sink down"); } })).toThrow("sink down");
    expect(db.query(`SELECT COUNT(*) AS n FROM outbox WHERE published_at IS NULL`).get().n).toBe(1);
    const seen = [];
    expect(publishOutbox(db, { sink: (e) => seen.push(e.eventId) })).toBe(1);
    expect(seen).toEqual(["a"]);
  });
});
