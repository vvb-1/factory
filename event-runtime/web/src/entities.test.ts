import { describe, expect, test } from "bun:test";
import { type EntityKind, resolveEntity } from "./entities";

describe("resolveEntity tickets", () => {
  test("routes a ticket key to the ticket journey", () => {
    expect(resolveEntity("ticket", "WM-700")).toEqual({
      kind: "ticket",
      id: "WM-700",
      label: "WM-700",
      path: "tickets/WM-700",
      href: "#/tickets/WM-700",
      externalHref: null,
    });
  });

  test("canonicalises case and surrounding space", () => {
    expect(resolveEntity("ticket", "  clnt-616 ")?.id).toBe("CLNT-616");
  });

  test("rejects prose that is not a ticket key", () => {
    expect(resolveEntity("ticket", "fix the thing")).toBeNull();
    expect(resolveEntity("ticket", "WM700")).toBeNull();
    expect(resolveEntity("ticket", "700")).toBeNull();
  });
});

describe("resolveEntity pull requests", () => {
  test("routes a bare number to the PR journey", () => {
    expect(resolveEntity("pr", 541)).toEqual({
      kind: "pr",
      id: "541",
      label: "PR #541",
      path: "prs/541",
      href: "#/prs/541",
      externalHref: null,
    });
  });

  test("accepts the #-prefixed form", () => {
    expect(resolveEntity("pr", "#541")?.href).toBe("#/prs/541");
  });

  test("keeps GitHub as an external href, never as the in-app route", () => {
    const pr = resolveEntity(
      "pr",
      "https://github.com/watt-mind/factory/pull/541",
    );
    expect(pr?.href).toBe("#/prs/541");
    expect(pr?.externalHref).toBe(
      "https://github.com/watt-mind/factory/pull/541",
    );
  });

  test("builds the GitHub href from a number when the repo is known", () => {
    expect(
      resolveEntity("pr", 12, { repo: "watt-mind/factory" })?.externalHref,
    ).toBe("https://github.com/watt-mind/factory/pull/12");
  });

  test("rejects a non-numeric or zero pull request", () => {
    expect(resolveEntity("pr", "abc")).toBeNull();
    expect(resolveEntity("pr", "0")).toBeNull();
    expect(resolveEntity("pr", "00")).toBeNull();
    expect(resolveEntity("pr", "000")).toBeNull();
    expect(
      resolveEntity("pr", "https://github.com/watt-mind/factory/pull/00"),
    ).toBeNull();
  });

  test("canonicalises a leading-zero positive number", () => {
    const pr = resolveEntity("pr", "0541");
    expect(pr?.id).toBe("541");
    expect(pr?.href).toBe("#/prs/541");
  });
});

describe("resolveEntity artifact shas", () => {
  const sha = "a".repeat(64);

  test("routes a sha256 to the artifact and shortens the label", () => {
    expect(resolveEntity("sha", sha)).toEqual({
      kind: "sha",
      id: sha,
      label: "a".repeat(12),
      path: `artifacts/${sha}`,
      href: `#/artifacts/${sha}`,
      externalHref: null,
    });
  });

  test("strips a sha256: prefix and lower-cases the digest", () => {
    expect(resolveEntity("sha", `sha256:${"B".repeat(64)}`)?.id).toBe(
      "b".repeat(64),
    );
  });

  test("keeps a short git sha whole", () => {
    expect(resolveEntity("sha", "a1b2c3d")?.label).toBe("a1b2c3d");
  });

  test("rejects anything that is not hex", () => {
    expect(resolveEntity("sha", "not-a-sha")).toBeNull();
    expect(resolveEntity("sha", "a1b2c")).toBeNull();
  });
});

describe("resolveEntity agents, runs, and events", () => {
  test("routes an agent ref, encoding the version suffix", () => {
    const agent = resolveEntity("agent", "factory-status-report@1");
    expect(agent?.path).toBe("agents/factory-status-report%401");
    expect(agent?.href).toBe("#/agents/factory-status-report%401");
    expect(agent?.label).toBe("factory-status-report@1");
  });

  test("routes a run to the full-page run view, not the list row", () => {
    expect(resolveEntity("run", "run_test_1001")?.href).toBe(
      "#/run/run_test_1001",
    );
  });

  test("routes an event that carries its own source", () => {
    expect(resolveEntity("event", "github/evt_1001")?.href).toBe(
      "#/events/github/evt_1001",
    );
    expect(resolveEntity("event", "github:evt_1001")?.href).toBe(
      "#/events/github/evt_1001",
    );
  });

  test("takes the event source from options when the id is bare", () => {
    const event = resolveEntity("event", "evt_1001", { source: "web" });
    expect(event?.href).toBe("#/events/web/evt_1001");
    expect(event?.id).toBe("evt_1001");
  });

  test("refuses an event with no source rather than misreading the id", () => {
    expect(resolveEntity("event", "evt_1001")).toBeNull();
  });
});

describe("resolveEntity guards", () => {
  const kinds: EntityKind[] = ["ticket", "pr", "sha", "agent", "run", "event"];

  test("every kind refuses an empty or missing id", () => {
    for (const kind of kinds) {
      expect(resolveEntity(kind, null)).toBeNull();
      expect(resolveEntity(kind, undefined)).toBeNull();
      expect(resolveEntity(kind, "   ")).toBeNull();
    }
  });

  test("every resolved href is its path behind the hash prefix", () => {
    const resolved = [
      resolveEntity("ticket", "WM-700"),
      resolveEntity("pr", 1),
      resolveEntity("sha", "a".repeat(64)),
      resolveEntity("agent", "triage-scan"),
      resolveEntity("run", "run_1"),
      resolveEntity("event", "github/evt_1"),
    ];
    expect(resolved.every((e) => e != null)).toBe(true);
    for (const entity of resolved)
      expect(entity?.href).toBe(`#/${entity?.path}`);
  });
});
