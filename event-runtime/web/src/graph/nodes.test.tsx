import "../test-dom";
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
import { AgentNode, EventTypeNode, ProposalNode, TerminalNode } from "./nodes";
import type { GraphNode } from "./model";

afterEach(() => {
  cleanup();
});

function renderNode(ui: React.ReactElement) {
  return render(<ReactFlowProvider>{ui}</ReactFlowProvider>);
}

const nodeProps = (node: GraphNode, extra: Record<string, unknown> = {}) =>
  ({
    id: node.id,
    data: { node, ...extra },
    selected: false,
    type: node.kind,
    zIndex: 0,
    isConnectable: false,
    positionAbsoluteX: 0,
    positionAbsoluteY: 0,
    dragging: false,
    selectable: true,
    deletable: false,
    draggable: false,
  }) as any;

describe("AgentNode", () => {
  test("renders basic agent details and contract when no active runs exist", () => {
    const node: GraphNode = {
      id: "agent:doctor@1",
      kind: "agent",
      label: "doctor@1",
      adapter: "claude",
      mutating: false,
      execution: "model",
      contract: "contract/ci-doctor/v1",
      capabilities: ["ci:read"],
      actions: [],
      hosts: [],
    };

    const { getByText } = renderNode(<AgentNode {...nodeProps(node)} />);
    expect(getByText("doctor@1")).toBeTruthy();
    expect(getByText("agent · model")).toBeTruthy();
    expect(getByText("contract/ci-doctor/v1")).toBeTruthy();
    expect(getByText("ci:read")).toBeTruthy();
  });

  test("renders active run state indicators (RUNNING, QUEUED) using StateBadge styling", () => {
    const node: GraphNode = {
      id: "agent:doctor@1",
      kind: "agent",
      label: "doctor@1",
      adapter: "claude",
      mutating: true,
      execution: "command",
      contract: "contract/ci-doctor/v1",
      capabilities: [],
      actions: [],
      hosts: [],
      activeRuns: [
        { state: "RUNNING", count: 1 },
        { state: "QUEUED", count: 3 },
      ],
    };

    const { getByText } = renderNode(<AgentNode {...nodeProps(node)} />);
    expect(getByText("RUNNING")).toBeTruthy();
    expect(getByText("QUEUED 3")).toBeTruthy();
    expect(getByText("mutating")).toBeTruthy();
    expect(getByText("agent · command")).toBeTruthy();
  });
});

describe("EventTypeNode", () => {
  test("renders event type without counts when no events exist", () => {
    const node: GraphNode = {
      id: "event:gh.failed",
      kind: "eventType",
      label: "gh.failed",
      adapter: "claude",
      scope: ["repo", "sha"],
      ttl: 1800,
    };

    const { getByText } = renderNode(<EventTypeNode {...nodeProps(node)} />);
    expect(getByText("gh.failed")).toBeTruthy();
    expect(getByText("dedup: repo + sha")).toBeTruthy();
    expect(getByText("ttl: 30m")).toBeTruthy();
  });

  test("renders admitted and planned counts when live events exist", () => {
    const node: GraphNode = {
      id: "event:gh.failed",
      kind: "eventType",
      label: "gh.failed",
      adapter: "claude",
      scope: ["repo"],
      ttl: null,
      admittedCount: 4,
      plannedCount: 2,
    };

    const { getByText } = renderNode(<EventTypeNode {...nodeProps(node)} />);
    expect(getByText("4 admitted")).toBeTruthy();
    expect(getByText("2 planned")).toBeTruthy();
    expect(getByText("4 admitted · 2 planned")).toBeTruthy();
  });
});

describe("ProposalNode", () => {
  test("renders open proposal with decision StateBadge and agent ref", () => {
    const node: GraphNode = {
      id: "proposal:prop_123",
      kind: "proposal",
      label: "pending: ci-rerun@1",
      proposalId: "prop_123",
      decision: "run",
      agentRef: "ci-rerun@1",
      eventType: "ci.rerun",
      proposal: {
        id: "prop_123",
        decision: "run",
        status: "open",
        expired: false,
        created_at: new Date().toISOString(),
        ttl_seconds: 600,
        decided_at: null,
        decided_by: null,
        reason: null,
        runId: "run_456",
        eventId: "ev_789",
        eventSource: "gh",
        agent: "ci-rerun@1",
        spec: null,
        repos: [],
      },
    };

    const { getByText } = renderNode(<ProposalNode {...nodeProps(node)} />);
    expect(getByText("pending: ci-rerun@1")).toBeTruthy();
    expect(getByText("run")).toBeTruthy();
    expect(getByText("agent: ci-rerun@1")).toBeTruthy();
    expect(getByText(/ttl: 600s remaining/)).toBeTruthy();
  });
});

describe("TerminalNode", () => {
  test("renders terminal node with reason", () => {
    const node: GraphNode = {
      id: "terminal:doctor@1",
      kind: "terminal",
      label: "chain ends",
      reason: "TICKET, ENV",
    };

    const { getByText } = renderNode(<TerminalNode {...nodeProps(node)} />);
    expect(getByText("chain ends")).toBeTruthy();
    expect(getByText("TICKET, ENV")).toBeTruthy();
  });
});
