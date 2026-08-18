import { describe, expect, test } from "bun:test";
import {
  EDGE_STYLES,
  NODE_STYLES,
  historicalColor,
  historicalRamp,
  historicalStroke,
  legendEntries,
  nodeStyleKey,
} from "./style";
import type {
  CapabilityGraph,
  GraphNode,
  HistoricalOverlayValue,
} from "./model";

const agent = (ref: string, mutating: boolean): GraphNode => ({
  id: `agent:${ref}`,
  kind: "agent",
  label: ref,
  adapter: "claude",
  mutating,
  execution: "model",
  contract: "c/v1",
  capabilities: [],
  actions: [],
  hosts: [],
});

describe("nodeStyleKey", () => {
  test("splits agents by mutating flag, passes other kinds through", () => {
    expect(nodeStyleKey(agent("a@1", false))).toBe("agentReadOnly");
    expect(nodeStyleKey(agent("a@1", true))).toBe("agentMutating");
    expect(
      nodeStyleKey({
        id: "terminal:a@1",
        kind: "terminal",
        label: "chain ends",
        reason: "done",
      }),
    ).toBe("terminal");
    expect(
      nodeStyleKey({
        id: "proposal:p1",
        kind: "proposal",
        label: "pending: a@1",
        proposalId: "p1",
        decision: "run",
        agentRef: "a@1",
        eventType: null,
        proposal: {} as any,
      }),
    ).toBe("proposal");
  });
});

describe("legendEntries", () => {
  test("lists only styles the graph actually uses", () => {
    const graph: CapabilityGraph = {
      nodes: [
        {
          id: "event:a",
          kind: "eventType",
          label: "a",
          adapter: "claude",
          scope: [],
          ttl: null,
        },
        agent("a@1", false),
      ],
      edges: [
        {
          id: "routes:a",
          source: "event:a",
          target: "agent:a@1",
          kind: "routes",
        },
      ],
    };
    const legend = legendEntries(graph);
    expect(legend.nodes.map((n) => n.key)).toEqual([
      "eventType",
      "agentReadOnly",
    ]);
    expect(legend.edges.map((e) => e.kind)).toEqual(["routes"]);
  });

  test("full graph advertises every style, carrying the shared constants", () => {
    const graph: CapabilityGraph = {
      nodes: [
        {
          id: "event:a",
          kind: "eventType",
          label: "a",
          adapter: "claude",
          scope: [],
          ttl: null,
        },
        agent("a@1", false),
        agent("b@1", true),
        {
          id: "terminal:b@1",
          kind: "terminal",
          label: "chain ends",
          reason: "done",
        },
        {
          id: "proposal:p1",
          kind: "proposal",
          label: "pending: b@1",
          proposalId: "p1",
          decision: "run",
          agentRef: "b@1",
          eventType: "a",
          proposal: {} as any,
        },
      ],
      edges: [
        {
          id: "routes:a",
          source: "event:a",
          target: "agent:a@1",
          kind: "routes",
        },
        {
          id: "rec:b@1:x",
          source: "agent:b@1",
          target: "event:a",
          kind: "recommends",
        },
        {
          id: "prop:1",
          source: "event:a",
          target: "proposal:p1",
          kind: "proposal",
        },
      ],
    };
    const legend = legendEntries(graph);
    expect(legend.nodes).toEqual([
      { key: "eventType", ...NODE_STYLES.eventType },
      { key: "agentReadOnly", ...NODE_STYLES.agentReadOnly },
      { key: "agentMutating", ...NODE_STYLES.agentMutating },
      { key: "terminal", ...NODE_STYLES.terminal },
      { key: "proposal", ...NODE_STYLES.proposal },
    ]);
    expect(legend.edges).toEqual([
      { kind: "routes", ...EDGE_STYLES.routes },
      { kind: "recommends", ...EDGE_STYLES.recommends },
      { kind: "proposal", ...EDGE_STYLES.proposal },
    ]);
  });

  test("empty graph yields an empty legend", () => {
    expect(legendEntries({ nodes: [], edges: [] })).toEqual({
      nodes: [],
      edges: [],
    });
  });
});

describe("historical ramps", () => {
  const value = (
    over: Partial<HistoricalOverlayValue> = {},
  ): HistoricalOverlayValue => ({
    mode: "activity",
    value: 5,
    intensity: 0.5,
    formatted: "5",
    label: "runs",
    faint: false,
    noData: false,
    ...over,
  });

  test("uses theme variables for sequential and health ramps", () => {
    expect(historicalColor(value())).toContain("var(--accent)");
    expect(
      historicalStroke(
        value({
          mode: "health",
          value: 0.5,
          intensity: 0.5,
          formatted: "50%",
          label: "failure rate",
        }),
      ),
    ).toBe("color-mix(in oklch, var(--hue-err) 50%, var(--hue-ok))");
  });

  // WM-291 review D4: the node background sits under body text on `var(--text)`.
  // A full-strength `--accent` or `--hue-err` fill leaves near-black text on
  // dark blue. theme.css tints row backgrounds at 6-14%; the ramp's ceiling
  // must stay in that neighbourhood while still reading as a gradient.
  describe("node background stays a tint", () => {
    const outerPct = (css: string) => {
      const match = /\s(\d+)%, var\(--surface-1\)\)$/.exec(css);
      expect(match).not.toBeNull();
      return Number(match![1]);
    };

    test("caps the hottest sequential cell well below a full fill", () => {
      expect(historicalColor(value({ intensity: 1 }))).toBe(
        "color-mix(in oklch, var(--accent) 22%, var(--surface-1))",
      );
      expect(
        outerPct(historicalColor(value({ intensity: 1 }))),
      ).toBeLessThanOrEqual(25);
    });

    test("caps the hottest health cell too, and keeps the hue ramp inside it", () => {
      const worst = historicalColor(
        value({ mode: "health", intensity: 1, formatted: "100%" }),
      );
      const best = historicalColor(
        value({ mode: "health", intensity: 0, formatted: "0%" }),
      );
      expect(worst).toBe(
        "color-mix(in oklch, color-mix(in oklch, var(--hue-err) 100%, var(--hue-ok)) 22%, var(--surface-1))",
      );
      expect(best).toBe(
        "color-mix(in oklch, color-mix(in oklch, var(--hue-err) 0%, var(--hue-ok)) 5%, var(--surface-1))",
      );
      expect(outerPct(worst)).toBeLessThanOrEqual(25);
    });

    test("every cell across the ramp is a surface tint, and the ramp still moves", () => {
      const strengths = [0, 0.25, 0.5, 0.75, 1].map((intensity) =>
        outerPct(historicalColor(value({ intensity }))),
      );
      expect(strengths.every((pct) => pct <= 25)).toBe(true);
      // Monotonic and actually distinguishable end to end.
      expect(strengths).toEqual([...strengths].sort((a, b) => a - b));
      expect(strengths[4]! - strengths[0]!).toBeGreaterThanOrEqual(10);
    });

    test("a no-data node takes no ramp colour at all", () => {
      expect(
        historicalColor(
          value({ mode: "health", intensity: 0, noData: true, formatted: "—" }),
        ),
      ).toBe("var(--surface-1)");
    });
  });

  test("edge strokes keep full saturation — a 1.5px line carries no text", () => {
    expect(historicalStroke(value({ mode: "health", intensity: 1 }))).toBe(
      "color-mix(in oklch, var(--hue-err) 100%, var(--hue-ok))",
    );
  });

  test("finds the visible min and max for the legend", () => {
    const low = value({
      mode: "cost",
      value: 0,
      intensity: 0,
      formatted: "$0.000",
      label: "spend",
    });
    const high = value({
      mode: "cost",
      value: 4,
      intensity: 1,
      formatted: "$4.00",
      label: "spend",
    });
    const graph: CapabilityGraph = {
      nodes: [
        {
          id: "event:a",
          kind: "eventType",
          label: "a",
          adapter: "claude",
          scope: [],
          ttl: null,
          historical: low,
        },
        { ...agent("a@1", false), historical: high },
      ],
      edges: [],
    };
    expect(historicalRamp(graph)).toEqual({ min: low, max: high });
  });

  test("no-data nodes stay out of the legend ramp", () => {
    const missing = value({
      mode: "cost",
      value: 0,
      intensity: 0,
      formatted: "—",
      noData: true,
      faint: true,
      label: "spend",
    });
    const spent = value({
      mode: "cost",
      value: 4,
      intensity: 1,
      formatted: "$4.00",
      label: "spend",
    });
    const graph: CapabilityGraph = {
      nodes: [
        {
          id: "event:a",
          kind: "eventType",
          label: "a",
          adapter: "claude",
          scope: [],
          ttl: null,
          historical: missing,
        },
        { ...agent("a@1", false), historical: spent },
      ],
      edges: [],
    };
    expect(historicalRamp(graph)).toEqual({ min: spent, max: spent });
  });
});
