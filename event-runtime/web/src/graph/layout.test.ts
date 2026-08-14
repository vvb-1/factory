import "../test-dom";
import { describe, expect, test } from "bun:test";
import { layoutGraph, LAYOUT_TIMEOUT_MS, NODE_HEIGHT, NODE_WIDTH } from "./layout";
import type { CapabilityGraph } from "./model";

describe("layoutGraph", () => {
  test("exports layout constants", () => {
    expect(NODE_WIDTH).toBe(236);
    expect(NODE_HEIGHT).toBe(92);
    expect(LAYOUT_TIMEOUT_MS).toBe(3000);
  });

  test("calculates positions for nodes and edges in a graph", async () => {
    const graph: CapabilityGraph = {
      nodes: [
        { id: "event:gh.failed", kind: "eventType", label: "gh.failed", adapter: "claude", scope: [], ttl: null },
        {
          id: "agent:doctor@1",
          kind: "agent",
          label: "doctor@1",
          adapter: "claude",
          mutating: false,
          execution: "model",
          contract: "c/v1",
          capabilities: [],
          actions: [],
          hosts: [],
        },
      ],
      edges: [
        { id: "routes:gh.failed", source: "event:gh.failed", target: "agent:doctor@1", kind: "routes" },
      ],
    };

    const positions = await layoutGraph(graph);
    expect(positions.has("event:gh.failed")).toBe(true);
    expect(positions.has("agent:doctor@1")).toBe(true);
    const eventPos = positions.get("event:gh.failed")!;
    const agentPos = positions.get("agent:doctor@1")!;
    expect(typeof eventPos.x).toBe("number");
    expect(typeof eventPos.y).toBe("number");
    expect(typeof agentPos.x).toBe("number");
    expect(typeof agentPos.y).toBe("number");
    // Left-to-right direction means target agent is positioned to the right of source event
    expect(agentPos.x).toBeGreaterThan(eventPos.x);
  });

  test("rejects when layout calculation exceeds bounded timeout", async () => {
    const graph: CapabilityGraph = {
      nodes: [
        { id: "event:e1", kind: "eventType", label: "e1", adapter: "a", scope: [], ttl: null },
      ],
      edges: [],
    };

    // With timeoutMs = 0 (or 1ms), it must reject with a timeout error
    await expect(layoutGraph(graph, 0)).rejects.toThrow(/timed out/i);
  });
});
