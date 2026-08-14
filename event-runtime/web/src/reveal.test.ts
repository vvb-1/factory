import { describe, expect, test } from "bun:test";
import { decideRevealFilters, formatRevealNotification } from "./reveal";

describe("formatRevealNotification", () => {
  test("returns null when neither tab nor filter was changed (silent reveal)", () => {
    expect(
      formatRevealNotification({
        kind: "run",
        id: "run_01",
        state: "RUNNING",
        tabChanged: false,
        filterCleared: false,
      }),
    ).toBeNull();

    expect(
      formatRevealNotification({
        kind: "event",
        id: "evt_01",
        state: "queued",
        tabChanged: false,
        filterCleared: false,
      }),
    ).toBeNull();
  });

  test("formats tab changed with state reason", () => {
    expect(
      formatRevealNotification({
        kind: "run",
        id: "run_01",
        state: "CANCELLED",
        tabChanged: true,
        filterCleared: false,
      }),
    ).toBe("Showing all states — run run_01 is CANCELLED");

    expect(
      formatRevealNotification({
        kind: "event",
        id: "evt_02",
        state: "dead_lettered",
        tabChanged: true,
        filterCleared: false,
      }),
    ).toBe("Showing all states — event evt_02 is dead_lettered");
  });

  test("formats tab changed without state reason", () => {
    expect(
      formatRevealNotification({
        kind: "run",
        id: "run_01",
        tabChanged: true,
        filterCleared: false,
      }),
    ).toBe("Showing all states to show run run_01");
  });

  test("formats filter cleared", () => {
    expect(
      formatRevealNotification({
        kind: "run",
        id: "run_01",
        tabChanged: false,
        filterCleared: true,
      }),
    ).toBe("Cleared the filter to show run run_01");

    expect(
      formatRevealNotification({
        kind: "event",
        id: "evt_03",
        tabChanged: false,
        filterCleared: true,
      }),
    ).toBe("Cleared the filter to show event evt_03");
  });

  test("formats both tab changed and filter cleared as one message", () => {
    expect(
      formatRevealNotification({
        kind: "run",
        id: "run_01",
        state: "CANCELLED",
        tabChanged: true,
        filterCleared: true,
      }),
    ).toBe("Showing all states and cleared filter — run run_01 is CANCELLED");

    expect(
      formatRevealNotification({
        kind: "event",
        id: "evt_04",
        state: "human_needed",
        tabChanged: true,
        filterCleared: true,
      }),
    ).toBe("Showing all states and cleared filter — event evt_04 is human_needed");
  });
});

describe("decideRevealFilters", () => {
  test("when target row is already visible, keeps all filters and clears nothing", () => {
    const snapshot = { filter: "error", typeFilter: "deploy", sourceFilter: null };
    const current = { filter: "error", typeFilter: "deploy", sourceFilter: null };
    const empty = { filter: "", typeFilter: null, sourceFilter: null };

    const result = decideRevealFilters(snapshot, current, empty, true);
    expect(result.cleared).toBe(false);
    expect(result.clearedFields).toEqual([]);
    expect(result.next).toEqual(current);
  });

  test("when target row is hidden and filters are unchanged from snapshot, clears all non-empty fields", () => {
    const snapshot = { filter: "error", typeFilter: "deploy", sourceFilter: null };
    const current = { filter: "error", typeFilter: "deploy", sourceFilter: null };
    const empty = { filter: "", typeFilter: null, sourceFilter: null };

    const result = decideRevealFilters(snapshot, current, empty, false);
    expect(result.cleared).toBe(true);
    expect(result.clearedFields).toEqual(["filter", "typeFilter"]);
    expect(result.next).toEqual({ filter: "", typeFilter: null, sourceFilter: null });
  });

  test("Events: preserving a newly typed text filter while clearing stale type/source filters", () => {
    const snapshot = { filter: "", typeFilter: "deploy", sourceFilter: "github" };
    // Operator typed "new search" after latch armed, but left typeFilter/sourceFilter untouched
    const current = { filter: "new search", typeFilter: "deploy", sourceFilter: "github" };
    const empty = { filter: "", typeFilter: null, sourceFilter: null };

    const result = decideRevealFilters(snapshot, current, empty, false);
    expect(result.cleared).toBe(true);
    expect(result.clearedFields).toEqual(["typeFilter", "sourceFilter"]);
    expect(result.next).toEqual({ filter: "new search", typeFilter: null, sourceFilter: null });
  });

  test("Events: preserving modified type chip while clearing stale text filter", () => {
    const snapshot = { filter: "old filter", typeFilter: null, sourceFilter: null };
    // Operator selected "webhook" type chip after latch armed
    const current = { filter: "old filter", typeFilter: "webhook", sourceFilter: null };
    const empty = { filter: "", typeFilter: null, sourceFilter: null };

    const result = decideRevealFilters(snapshot, current, empty, false);
    expect(result.cleared).toBe(true);
    expect(result.clearedFields).toEqual(["filter"]);
    expect(result.next).toEqual({ filter: "", typeFilter: "webhook", sourceFilter: null });
  });

  test("Proposals: preserving newly typed filter while clearing stale expiredOnly", () => {
    const snapshot = { filter: "", expiredOnly: true };
    const current = { filter: "agent:reaper", expiredOnly: true };
    const empty = { filter: "", expiredOnly: false };

    const result = decideRevealFilters(snapshot, current, empty, false);
    expect(result.cleared).toBe(true);
    expect(result.clearedFields).toEqual(["expiredOnly"]);
    expect(result.next).toEqual({ filter: "agent:reaper", expiredOnly: false });
  });

  test("Proposals: preserving modified expiredOnly while clearing stale text filter", () => {
    const snapshot = { filter: "old proposal", expiredOnly: false };
    const current = { filter: "old proposal", expiredOnly: true };
    const empty = { filter: "", expiredOnly: false };

    const result = decideRevealFilters(snapshot, current, empty, false);
    expect(result.cleared).toBe(true);
    expect(result.clearedFields).toEqual(["filter"]);
    expect(result.next).toEqual({ filter: "", expiredOnly: true });
  });

  test("Runs: clears unchanged filter when row is hidden", () => {
    const snapshot = { filter: "state:FAILED" };
    const current = { filter: "state:FAILED" };
    const empty = { filter: "" };

    const result = decideRevealFilters(snapshot, current, empty, false);
    expect(result.cleared).toBe(true);
    expect(result.clearedFields).toEqual(["filter"]);
    expect(result.next).toEqual({ filter: "" });
  });

  test("Runs: preserves operator-typed filter when row arrives late", () => {
    const snapshot = { filter: "" };
    const current = { filter: "agent:worker" };
    const empty = { filter: "" };

    const result = decideRevealFilters(snapshot, current, empty, false);
    expect(result.cleared).toBe(false);
    expect(result.clearedFields).toEqual([]);
    expect(result.next).toEqual({ filter: "agent:worker" });
  });
});
