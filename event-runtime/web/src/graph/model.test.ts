import { describe, expect, test } from "bun:test";
import { applyHistoricalOverlay, buildCapabilityGraph } from "./model";
import type { AgentsView, RunListItem, RunState } from "../types";

// The topology rules are pure data — tested without React or a browser.

const agent = (over: Partial<AgentsView["agents"][number]> = {}) =>
  ({
    ref: "a@1",
    id: "a",
    version: 1,
    outputContract: "c/v1",
    workspace: { type: "ephemeral" },
    capabilities: { services: ["x:read"] },
    limits: { timeout_seconds: 60, attempts: 1 },
    mutating: false,
    promptFile: "p.md",
    prompt: "",
    inputSchemaFile: "i.json",
    inputSchema: {},
    outputSchemaFile: "o.json",
    outputSchema: {},
    pins: {},
    command: null,
    actionRegistry: null,
    hosts: null,
    eventTypes: [],
    ...over,
  }) as AgentsView["agents"][number];

const view = (over: Partial<AgentsView> = {}): AgentsView => ({
  agents: [],
  edges: {},
  eventTypes: [],
  contracts: {},
  ...over,
});

const run = (runId: string, state: RunState, maxAttempts = 3): RunListItem => ({
  runId,
  spec: {
    schemaVersion: "factory.run-spec/v1",
    runId,
    agent: "doctor@1",
    input: { repo: "factory" },
    inputHash: `sha256:${runId}`,
    workspace: { type: "ephemeral" },
    adapter: "claude",
    promptVersion: "1",
    policyVersion: "1",
    outputContract: "doctor/v1",
    capabilities: [],
    timeoutSeconds: 600,
    maxAttempts,
    idempotencyKey: `idem-${runId}`,
  },
  state,
  agent: "doctor@1",
  attempts: 1,
  maxAttempts,
  adapter: "claude",
  reasonCode: null,
  eventId: null,
  eventSource: null,
  created_at: "",
  updated_at: "",
  repos: [],
});

describe("buildCapabilityGraph", () => {
  test("routes event types to their agents", () => {
    const g = buildCapabilityGraph(
      view({
        agents: [agent({ ref: "doctor@1" })],
        eventTypes: [
          {
            type: "gh.failed",
            agent: "doctor@1",
            adapter: "claude",
            idempotencyScope: ["inputHash"],
            proposalTtlSeconds: 1800,
          },
        ],
      }),
    );
    expect(g.nodes.map((n) => n.id)).toEqual([
      "event:gh.failed",
      "agent:doctor@1",
    ]);
    expect(g.edges).toEqual([
      {
        id: "routes:gh.failed",
        source: "event:gh.failed",
        target: "agent:doctor@1",
        kind: "routes",
      },
    ]);
  });

  test("draws recommendation edges from an agent to follow-up event types", () => {
    const g = buildCapabilityGraph(
      view({
        agents: [
          agent({ ref: "doctor@1" }),
          agent({ ref: "rerun@1", mutating: true, command: ["gh", "run"] }),
        ],
        eventTypes: [
          {
            type: "gh.failed",
            agent: "doctor@1",
            adapter: "claude",
            idempotencyScope: [],
            proposalTtlSeconds: null,
          },
          {
            type: "ci.rerun",
            agent: "rerun@1",
            adapter: "command",
            idempotencyScope: [],
            proposalTtlSeconds: null,
          },
        ],
        edges: {
          "doctor@1": {
            recommendationField: "verdict",
            edges: { FLAKE: { eventType: "ci.rerun", input: {} } },
          },
        },
      }),
    );
    const rec = g.edges.find((e) => e.kind === "recommends");
    expect(rec).toMatchObject({
      source: "agent:doctor@1",
      target: "event:ci.rerun",
      label: "verdict = FLAKE",
    });
    const rerun = g.nodes.find((n) => n.id === "agent:rerun@1");
    expect(rerun).toMatchObject({
      kind: "agent",
      mutating: true,
      execution: "command",
    });
  });

  test("unmapped enum values become one terminal — 'the chain ends here' is topology", () => {
    const g = buildCapabilityGraph(
      view({
        agents: [
          agent({
            ref: "doctor@1",
            outputSchema: {
              properties: { verdict: { enum: ["TICKET", "ENV", "FLAKE"] } },
            },
          }),
          agent({ ref: "rerun@1" }),
        ],
        eventTypes: [
          {
            type: "gh.failed",
            agent: "doctor@1",
            adapter: "claude",
            idempotencyScope: [],
            proposalTtlSeconds: null,
          },
          {
            type: "ci.rerun",
            agent: "rerun@1",
            adapter: "command",
            idempotencyScope: [],
            proposalTtlSeconds: null,
          },
        ],
        edges: {
          "doctor@1": {
            recommendationField: "verdict",
            edges: { FLAKE: { eventType: "ci.rerun", input: {} } },
          },
        },
      }),
    );
    const terminal = g.nodes.find((n) => n.kind === "terminal");
    expect(terminal).toMatchObject({
      id: "terminal:doctor@1",
      reason: "TICKET, ENV",
    });
    expect(g.edges.some((e) => e.target === "terminal:doctor@1")).toBe(true);
  });

  test("fully-mapped enums draw no terminal", () => {
    const g = buildCapabilityGraph(
      view({
        agents: [
          agent({
            ref: "d@1",
            outputSchema: { properties: { r: { enum: ["GO"] } } },
          }),
          agent({ ref: "next@1" }),
        ],
        eventTypes: [
          {
            type: "t.next",
            agent: "next@1",
            adapter: "command",
            idempotencyScope: [],
            proposalTtlSeconds: null,
          },
        ],
        edges: {
          "d@1": {
            recommendationField: "r",
            edges: { GO: { eventType: "t.next", input: {} } },
          },
        },
      }),
    );
    expect(g.nodes.some((n) => n.kind === "terminal")).toBe(false);
  });

  test("never draws an edge to an unregistered target", () => {
    const g = buildCapabilityGraph(
      view({
        agents: [agent({ ref: "d@1" })],
        edges: {
          "d@1": {
            recommendationField: "r",
            edges: { GO: { eventType: "nope.missing", input: {} } },
          },
        },
      }),
    );
    expect(g.edges).toEqual([]);
  });

  test("action-registry agents report their execution shape, actions, and hosts", () => {
    const g = buildCapabilityGraph(
      view({
        agents: [
          agent({
            ref: "remediate@1",
            mutating: true,
            actionRegistry: {
              "docker-builder-prune": {
                remote: "sudo docker builder prune -af",
              },
            },
            hosts: ["lab", "web"],
          }),
        ],
      }),
    );
    expect(g.nodes[0]).toMatchObject({
      kind: "agent",
      execution: "actions",
      actions: ["docker-builder-prune"],
      hosts: ["lab", "web"],
    });
  });

  test("overlays agent active run state indicators (RUNNING, QUEUED)", () => {
    const g = buildCapabilityGraph(
      view({
        agents: [agent({ ref: "doctor@1" }), agent({ ref: "idle@1" })],
        eventTypes: [
          {
            type: "gh.failed",
            agent: "doctor@1",
            adapter: "claude",
            idempotencyScope: [],
            proposalTtlSeconds: null,
          },
        ],
      }),
      {
        runs: [
          run("r1", "RUNNING"),
          run("r2", "QUEUED"),
          run("r3", "QUEUED"),
          run("r4", "COMPLETED"),
        ],
      },
    );

    const docNode = g.nodes.find((n) => n.id === "agent:doctor@1") as any;
    expect(docNode.activeRuns).toEqual([
      { state: "RUNNING", count: 1 },
      { state: "QUEUED", count: 2 },
    ]);

    const idleNode = g.nodes.find((n) => n.id === "agent:idle@1") as any;
    expect(idleNode.activeRuns).toBeUndefined();
  });

  test("overlays admitted and planned counts on event-type nodes", () => {
    const g = buildCapabilityGraph(
      view({
        agents: [agent({ ref: "doctor@1" })],
        eventTypes: [
          {
            type: "ci.failed",
            agent: "doctor@1",
            adapter: "claude",
            idempotencyScope: [],
            proposalTtlSeconds: null,
          },
          {
            type: "ci.passed",
            agent: "doctor@1",
            adapter: "claude",
            idempotencyScope: [],
            proposalTtlSeconds: null,
          },
        ],
      }),
      {
        events: [
          {
            source: "gh",
            eventId: "e1",
            type: "ci.failed",
            subject: null,
            status: "admitted",
            occurredAt: "",
            receivedAt: "",
            correlationId: null,
            planFailures: 0,
            lastPlanError: null,
            admittedAt: "",
            proposalId: null,
            runId: null,
            envelope: {},
            repos: [],
          },
          {
            source: "gh",
            eventId: "e2",
            type: "ci.failed",
            subject: null,
            status: "admitted",
            occurredAt: "",
            receivedAt: "",
            correlationId: null,
            planFailures: 0,
            lastPlanError: null,
            admittedAt: "",
            proposalId: null,
            runId: null,
            envelope: {},
            repos: [],
          },
          {
            source: "gh",
            eventId: "e3",
            type: "ci.failed",
            subject: null,
            status: "planned",
            occurredAt: "",
            receivedAt: "",
            correlationId: null,
            planFailures: 0,
            lastPlanError: null,
            admittedAt: "",
            proposalId: null,
            runId: null,
            envelope: {},
            repos: [],
          },
        ],
      },
    );

    const failedNode = g.nodes.find((n) => n.id === "event:ci.failed") as any;
    expect(failedNode.admittedCount).toBe(2);
    expect(failedNode.plannedCount).toBe(1);

    const passedNode = g.nodes.find((n) => n.id === "event:ci.passed") as any;
    expect(passedNode.admittedCount).toBe(0);
    expect(passedNode.plannedCount).toBe(0);
  });

  test("recommendation edges display invocation counts correlated via causation IDs", () => {
    const g = buildCapabilityGraph(
      view({
        agents: [agent({ ref: "doctor@1" }), agent({ ref: "rerun@1" })],
        eventTypes: [
          {
            type: "ci.failed",
            agent: "doctor@1",
            adapter: "claude",
            idempotencyScope: [],
            proposalTtlSeconds: null,
          },
          {
            type: "ci.rerun",
            agent: "rerun@1",
            adapter: "command",
            idempotencyScope: [],
            proposalTtlSeconds: null,
          },
        ],
        edges: {
          "doctor@1": {
            recommendationField: "verdict",
            edges: { FLAKE: { eventType: "ci.rerun", input: {} } },
          },
        },
      }),
      {
        runs: [
          run("run-doc-101", "COMPLETED", 1),
          run("run-doc-102", "COMPLETED", 1),
        ],
        events: [
          {
            source: "factory.chain",
            eventId: "chain-1",
            type: "ci.rerun",
            subject: "doctor@1",
            status: "admitted",
            occurredAt: "",
            receivedAt: "",
            correlationId: "c1",
            causationId: "run-doc-101",
            planFailures: 0,
            lastPlanError: null,
            admittedAt: "",
            proposalId: null,
            runId: null,
            envelope: {},
            repos: [],
          } as any,
          {
            source: "factory.chain",
            eventId: "chain-2",
            type: "ci.rerun",
            subject: "doctor@1",
            status: "planned",
            occurredAt: "",
            receivedAt: "",
            correlationId: "c2",
            causationId: "run-doc-102",
            planFailures: 0,
            lastPlanError: null,
            admittedAt: "",
            proposalId: null,
            runId: null,
            envelope: {},
            repos: [],
          } as any,
        ],
      },
    );

    const recEdge = g.edges.find((e) => e.kind === "recommends");
    expect(recEdge).toBeDefined();
    expect(recEdge?.invocations).toBe(2);
    expect(recEdge?.label).toBe("verdict = FLAKE (2)");
  });

  test("open proposals render as dashed ghost nodes and edges representing pending execution", () => {
    const g = buildCapabilityGraph(
      view({
        agents: [agent({ ref: "rerun@1" })],
        eventTypes: [
          {
            type: "ci.rerun",
            agent: "rerun@1",
            adapter: "command",
            idempotencyScope: [],
            proposalTtlSeconds: null,
          },
        ],
      }),
      {
        events: [
          {
            source: "factory.chain",
            eventId: "ev-100",
            type: "ci.rerun",
            subject: null,
            status: "planned",
            occurredAt: "",
            receivedAt: "",
            correlationId: null,
            planFailures: 0,
            lastPlanError: null,
            admittedAt: "",
            proposalId: "prop-99",
            runId: null,
            envelope: {},
            repos: [],
          },
        ],
        proposals: [
          {
            id: "prop-99",
            decision: "run",
            status: "open",
            expired: false,
            created_at: new Date().toISOString(),
            ttl_seconds: 600,
            decided_at: null,
            decided_by: null,
            reason: null,
            runId: "run-next-1",
            eventId: "ev-100",
            eventSource: "factory.chain",
            agent: "rerun@1",
            spec: null,
            repos: [],
          },
        ],
      },
    );

    const propNode = g.nodes.find((n) => n.id === "proposal:prop-99");
    expect(propNode).toBeDefined();
    expect(propNode?.kind).toBe("proposal");
    expect(propNode?.label).toBe("pending: rerun@1");

    const eventToPropEdge = g.edges.find(
      (e) => e.source === "event:ci.rerun" && e.target === "proposal:prop-99",
    );
    expect(eventToPropEdge).toBeDefined();
    expect(eventToPropEdge?.kind).toBe("proposal");

    const propToAgentEdge = g.edges.find(
      (e) => e.source === "proposal:prop-99" && e.target === "agent:rerun@1",
    );
    expect(propToAgentEdge).toBeDefined();
    expect(propToAgentEdge?.kind).toBe("proposal");
  });
});

describe("applyHistoricalOverlay (WM-291)", () => {
  const topology = () =>
    buildCapabilityGraph(
      view({
        agents: [agent({ ref: "doctor@1" }), agent({ ref: "idle@1" })],
        eventTypes: [
          {
            type: "ci.failed",
            agent: "doctor@1",
            adapter: "claude",
            idempotencyScope: [],
            proposalTtlSeconds: null,
          },
          {
            type: "ci.idle",
            agent: "idle@1",
            adapter: "claude",
            idempotencyScope: [],
            proposalTtlSeconds: null,
          },
        ],
        edges: {
          "doctor@1": {
            recommendationField: "verdict",
            edges: { RETRY: { eventType: "ci.idle", input: {} } },
          },
        },
      }),
    );

  test("maps activity counts and explicitly fades zero-activity nodes", () => {
    const graph = applyHistoricalOverlay(topology(), "activity", {
      agents: { rows: [{ key: "doctor@1", value: 12 }] },
      eventTypes: { rows: [{ key: "ci.failed", value: 12 }] },
      edges: { rows: [{ key: "doctor@1→ci.idle", value: 3 }] },
    });
    expect(
      graph.nodes.find((n) => n.id === "agent:doctor@1")?.historical,
    ).toMatchObject({
      formatted: "12",
      intensity: 1,
      faint: false,
    });
    expect(
      graph.nodes.find((n) => n.id === "agent:idle@1")?.historical,
    ).toMatchObject({
      value: 0,
      faint: true,
    });
    expect(
      graph.edges.find((e) => e.kind === "recommends")?.historical,
    ).toMatchObject({
      value: 3,
      intensity: 0.25,
    });
  });

  test("maps health as failures divided by runs and formats latency/cost units", () => {
    const health = applyHistoricalOverlay(topology(), "health", {
      agents: { rows: [{ key: "doctor@1", value: 2 }] },
      agentRuns: { rows: [{ key: "doctor@1", value: 8 }] },
      eventTypes: { rows: [{ key: "ci.failed", value: 1 }] },
      eventTypeRuns: { rows: [{ key: "ci.failed", value: 4 }] },
      edges: { rows: [{ key: "doctor@1→ci.idle", value: 1 }] },
      edgeRuns: { rows: [{ key: "doctor@1→ci.idle", value: 2 }] },
    });
    expect(
      health.nodes.find((n) => n.id === "agent:doctor@1")?.historical,
    ).toMatchObject({
      value: 0.25,
      formatted: "25%",
    });
    expect(
      health.edges.find((e) => e.kind === "recommends")?.historical?.formatted,
    ).toBe("50%");

    const cost = applyHistoricalOverlay(topology(), "cost", {
      agents: { rows: [{ key: "doctor@1", value: 1.25 }] },
    });
    expect(
      cost.nodes.find((n) => n.id === "agent:doctor@1")?.historical?.formatted,
    ).toBe("$1.25");

    const latency = applyHistoricalOverlay(topology(), "latency", {
      agents: { rows: [{ key: "doctor@1", value: 2500 }] },
    });
    expect(
      latency.nodes.find((n) => n.id === "agent:doctor@1")?.historical
        ?.formatted,
    ).toBe("2.5s");
  });
});

describe("applyHistoricalOverlay guards (WM-291 review)", () => {
  // A topology with an open proposal: two ghost edges (event → proposal,
  // proposal → agent) alongside the routing and recommendation edges.
  const withProposal = () =>
    buildCapabilityGraph(
      view({
        agents: [agent({ ref: "doctor@1" }), agent({ ref: "rerun@1" })],
        eventTypes: [
          {
            type: "ci.failed",
            agent: "doctor@1",
            adapter: "claude",
            idempotencyScope: [],
            proposalTtlSeconds: null,
          },
          {
            type: "ci.rerun",
            agent: "rerun@1",
            adapter: "command",
            idempotencyScope: [],
            proposalTtlSeconds: null,
          },
        ],
        edges: {
          "doctor@1": {
            recommendationField: "verdict",
            edges: { FLAKE: { eventType: "ci.rerun", input: {} } },
          },
        },
      }),
      {
        events: [
          {
            source: "factory.chain",
            eventId: "ev-1",
            type: "ci.rerun",
            subject: null,
            status: "planned",
            occurredAt: "",
            receivedAt: "",
            correlationId: null,
            planFailures: 0,
            lastPlanError: null,
            admittedAt: "",
            proposalId: "prop-1",
            runId: null,
            envelope: {},
            repos: [],
          } as any,
        ],
        proposals: [
          {
            id: "prop-1",
            decision: "run",
            status: "open",
            expired: false,
            created_at: new Date().toISOString(),
            ttl_seconds: 600,
            decided_at: null,
            decided_by: null,
            reason: null,
            runId: "run-1",
            eventId: "ev-1",
            eventSource: "factory.chain",
            agent: "rerun@1",
            spec: null,
            repos: [],
          } as any,
        ],
      },
    );

  test("proposal edges take no overlay value — pending is not the healthy end of the ramp", () => {
    const graph = applyHistoricalOverlay(withProposal(), "health", {
      agents: { rows: [{ key: "doctor@1", value: 1 }] },
      agentRuns: { rows: [{ key: "doctor@1", value: 4 }] },
      eventTypes: { rows: [{ key: "ci.failed", value: 1 }] },
      eventTypeRuns: { rows: [{ key: "ci.failed", value: 4 }] },
      edges: { rows: [{ key: "doctor@1→ci.rerun", value: 1 }] },
      edgeRuns: { rows: [{ key: "doctor@1→ci.rerun", value: 4 }] },
    });

    const proposalEdges = graph.edges.filter((e) => e.kind === "proposal");
    expect(proposalEdges.length).toBeGreaterThan(0);
    for (const edge of proposalEdges) expect(edge.historical).toBeUndefined();
    // The measurable edges still get their reading.
    expect(
      graph.edges.find((e) => e.kind === "recommends")?.historical?.formatted,
    ).toBe("25%");
  });

  test("proposal nodes and edges stay unmeasured under every overlay", () => {
    for (const mode of ["activity", "health", "cost", "latency"] as const) {
      const graph = applyHistoricalOverlay(withProposal(), mode, {
        agents: { rows: [{ key: "doctor@1", value: 3 }] },
        agentRuns: { rows: [{ key: "doctor@1", value: 3 }] },
      });
      expect(
        graph.nodes.find((n) => n.kind === "proposal")?.historical,
      ).toBeUndefined();
      expect(
        graph.edges
          .filter((e) => e.kind === "proposal")
          .every((e) => !e.historical),
      ).toBe(true);
    }
  });

  test("a node with no runs reads as no data, not as a perfect score", () => {
    const health = applyHistoricalOverlay(withProposal(), "health", {
      agents: { rows: [{ key: "doctor@1", value: 1 }] },
      agentRuns: { rows: [{ key: "doctor@1", value: 4 }] },
      eventTypes: { rows: [] },
      eventTypeRuns: { rows: [] },
      edges: { rows: [] },
      edgeRuns: { rows: [] },
    });
    // rerun@1 never ran in the window: no denominator, so no failure rate.
    expect(
      health.nodes.find((n) => n.id === "agent:rerun@1")?.historical,
    ).toMatchObject({
      formatted: "—",
      noData: true,
      faint: true,
      intensity: 0,
    });
    // doctor@1 did run — a measured 25% is still shown.
    expect(
      health.nodes.find((n) => n.id === "agent:doctor@1")?.historical,
    ).toMatchObject({
      formatted: "25%",
      noData: false,
      faint: false,
    });
  });

  test("a measured zero is still a measurement — only a missing denominator is no data", () => {
    const health = applyHistoricalOverlay(withProposal(), "health", {
      agents: { rows: [] },
      agentRuns: { rows: [{ key: "rerun@1", value: 9 }] },
    });
    expect(
      health.nodes.find((n) => n.id === "agent:rerun@1")?.historical,
    ).toMatchObject({
      value: 0,
      formatted: "0%",
      noData: false,
      faint: false,
    });
  });

  test("latency and cost report no data rather than the fastest/cheapest reading", () => {
    const latency = applyHistoricalOverlay(withProposal(), "latency", {
      agents: { rows: [{ key: "doctor@1", value: 2500 }] },
      eventTypes: { rows: [] },
      edges: { rows: [] },
    });
    expect(
      latency.nodes.find((n) => n.id === "agent:rerun@1")?.historical,
    ).toMatchObject({
      formatted: "—",
      noData: true,
      faint: true,
    });
    expect(
      latency.nodes.find((n) => n.id === "agent:doctor@1")?.historical
        ?.formatted,
    ).toBe("2.5s");

    const cost = applyHistoricalOverlay(withProposal(), "cost", {
      agents: { rows: [{ key: "doctor@1", value: 1.25 }] },
    });
    expect(
      cost.nodes.find((n) => n.id === "agent:rerun@1")?.historical?.formatted,
    ).toBe("—");

    // Activity keeps its zeroes: a missing row there really is "no runs".
    const activity = applyHistoricalOverlay(withProposal(), "activity", {
      agents: { rows: [{ key: "doctor@1", value: 7 }] },
    });
    expect(
      activity.nodes.find((n) => n.id === "agent:rerun@1")?.historical,
    ).toMatchObject({
      formatted: "0",
      noData: false,
      faint: true,
    });
  });

  test("health is clamped to 100% — the server counts failures and runs on different clocks", () => {
    const health = applyHistoricalOverlay(withProposal(), "health", {
      // lib/metrics.mjs buckets failures by updated_at and runs by created_at,
      // so a run that started before the window and failed inside it makes the
      // ratio exceed 1.0. That must never render as "140%".
      agents: { rows: [{ key: "doctor@1", value: 14 }] },
      agentRuns: { rows: [{ key: "doctor@1", value: 10 }] },
    });
    expect(
      health.nodes.find((n) => n.id === "agent:doctor@1")?.historical,
    ).toMatchObject({
      value: 1,
      formatted: "100%",
    });
  });

  test("a negative ratio cannot drag the ramp below zero either", () => {
    const health = applyHistoricalOverlay(withProposal(), "health", {
      agents: { rows: [{ key: "doctor@1", value: -3 }] },
      agentRuns: { rows: [{ key: "doctor@1", value: 10 }] },
    });
    expect(
      health.nodes.find((n) => n.id === "agent:doctor@1")?.historical,
    ).toMatchObject({
      value: 0,
      formatted: "0%",
    });
  });
});
