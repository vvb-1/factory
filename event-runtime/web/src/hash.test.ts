import { describe, expect, test } from "bun:test";
import { hashPath, parseHash } from "./hash";

describe("parseHash", () => {
  test("empty hash is overview's empty route", () => {
    expect(parseHash("")).toEqual([]);
    expect(parseHash("#")).toEqual([]);
    expect(parseHash("#/")).toEqual([]);
  });

  test("splits view and id", () => {
    expect(parseHash("#/runs/run_01")).toEqual(["runs", "run_01"]);
    expect(parseHash("#/events/web/evt_1")).toEqual(["events", "web", "evt_1"]);
  });

  test("decodes encoded segments so agent refs round-trip", () => {
    expect(parseHash("#/agents/factory-status-report%401")).toEqual([
      "agents",
      "factory-status-report@1",
    ]);
    expect(parseHash("#/graph/event%3Afactory.ticket.ready")).toEqual([
      "graph",
      "event:factory.ticket.ready",
    ]);
  });
});

describe("hashPath", () => {
  test("encodes id segments", () => {
    expect(hashPath("runs")).toBe("runs");
    expect(hashPath("runs", "run_01")).toBe("runs/run_01");
    expect(hashPath("agents", "factory-status-report@1")).toBe(
      "agents/factory-status-report%401",
    );
    expect(hashPath("events", "web", "evt_1")).toBe("events/web/evt_1");
    expect(hashPath("graph", "event:factory.ticket.ready")).toBe(
      "graph/event%3Afactory.ticket.ready",
    );
  });

  test("drops null/empty ids so a closed panel is the view root", () => {
    expect(hashPath("runs", null)).toBe("runs");
    expect(hashPath("runs", undefined)).toBe("runs");
    expect(hashPath("events", "web", "")).toBe("events/web");
  });

  test("round-trips through parseHash", () => {
    const path = hashPath("agents", "factory-status-report@1");
    expect(parseHash(`#/${path}`)).toEqual(["agents", "factory-status-report@1"]);
  });
});
