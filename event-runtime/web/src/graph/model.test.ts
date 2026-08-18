import { describe, expect, test } from "bun:test";
import { buildCapabilityGraph } from "./model";
import type { AgentsView } from "../types";

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
          {
            runId: "r1",
            state: "RUNNING",
            agent: "doctor@1",
            attempts: 1,
            maxAttempts: 3,
            adapter: "claude",
            reasonCode: null,
            eventId: null,
            eventSource: null,
            created_at: "",
            updated_at: "",
            repos: [],
          },
          {
            runId: "r2",
            state: "QUEUED",
            agent: "doctor@1",
            attempts: 1,
            maxAttempts: 3,
            adapter: "claude",
            reasonCode: null,
            eventId: null,
            eventSource: null,
            created_at: "",
            updated_at: "",
            repos: [],
          },
          {
            runId: "r3",
            state: "QUEUED",
            agent: "doctor@1",
            attempts: 1,
            maxAttempts: 3,
            adapter: "claude",
            reasonCode: null,
            eventId: null,
            eventSource: null,
            created_at: "",
            updated_at: "",
            repos: [],
          },
          {
            runId: "r4",
            state: "COMPLETED",
            agent: "doctor@1",
            attempts: 1,
            maxAttempts: 3,
            adapter: "claude",
            reasonCode: null,
            eventId: null,
            eventSource: null,
            created_at: "",
            updated_at: "",
            repos: [],
          },
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
          {
            runId: "run-doc-101",
            state: "COMPLETED",
            agent: "doctor@1",
            attempts: 1,
            maxAttempts: 1,
            adapter: "claude",
            reasonCode: null,
            eventId: null,
            eventSource: null,
            created_at: "",
            updated_at: "",
            repos: [],
          },
          {
            runId: "run-doc-102",
            state: "COMPLETED",
            agent: "doctor@1",
            attempts: 1,
            maxAttempts: 1,
            adapter: "claude",
            reasonCode: null,
            eventId: null,
            eventSource: null,
            created_at: "",
            updated_at: "",
            repos: [],
          },
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
