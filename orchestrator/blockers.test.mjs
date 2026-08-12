import { describe, test, expect } from "bun:test";
import { openBlockers } from "./blockers.mjs";

const issueWith = (nodes) => ({ inverseRelations: { nodes } });

describe("openBlockers", () => {
  test("open blocker holds the ticket", () => {
    const i = issueWith([{ type: "blocks", issue: { identifier: "OPS-1", state: { type: "started" } } }]);
    expect(openBlockers(i)).toEqual(["OPS-1"]);
  });

  test("unstarted blocker holds too — Todo is not Done", () => {
    const i = issueWith([{ type: "blocks", issue: { identifier: "OPS-2", state: { type: "unstarted" } } }]);
    expect(openBlockers(i)).toEqual(["OPS-2"]);
  });

  test("completed blocker releases", () => {
    const i = issueWith([{ type: "blocks", issue: { identifier: "OPS-3", state: { type: "completed" } } }]);
    expect(openBlockers(i)).toEqual([]);
  });

  test("canceled blocker releases — dead work must not gate live work", () => {
    const i = issueWith([{ type: "blocks", issue: { identifier: "OPS-4", state: { type: "canceled" } } }]);
    expect(openBlockers(i)).toEqual([]);
  });

  test("no relations means dispatchable", () => {
    expect(openBlockers(issueWith([]))).toEqual([]);
  });

  test("relations never fetched means dispatchable — callers without the fragment keep today's behaviour", () => {
    expect(openBlockers({})).toEqual([]);
    expect(openBlockers(undefined)).toEqual([]);
  });

  test("duplicate/related relation types do not gate", () => {
    const i = issueWith([
      { type: "duplicate", issue: { identifier: "OPS-5", state: { type: "started" } } },
      { type: "related", issue: { identifier: "OPS-6", state: { type: "unstarted" } } },
    ]);
    expect(openBlockers(i)).toEqual([]);
  });

  test("mixed relations report only the open blockers", () => {
    const i = issueWith([
      { type: "blocks", issue: { identifier: "OPS-7", state: { type: "completed" } } },
      { type: "blocks", issue: { identifier: "OPS-8", state: { type: "started" } } },
      { type: "related", issue: { identifier: "OPS-9", state: { type: "started" } } },
      { type: "blocks", issue: { identifier: "OPS-10", state: { type: "backlog" } } },
    ]);
    expect(openBlockers(i)).toEqual(["OPS-8", "OPS-10"]);
  });

  test("handles more than the old relation page size", () => {
    const nodes = Array.from({ length: 26 }, (_, n) => ({
      type: "blocks",
      issue: { identifier: `OPS-${n + 20}`, state: { type: "started" } },
    }));
    expect(openBlockers(issueWith(nodes))).toHaveLength(26);
  });

  test("malformed node without an issue is ignored, not a crash", () => {
    const i = issueWith([{ type: "blocks", issue: null }]);
    expect(openBlockers(i)).toEqual([]);
  });
});
