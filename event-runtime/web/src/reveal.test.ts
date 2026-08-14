import { describe, expect, test } from "bun:test";
import { formatRevealNotification } from "./reveal";

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
