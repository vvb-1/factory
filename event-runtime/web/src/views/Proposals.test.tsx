import "../test-dom";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Proposals } from "./Proposals";
import { api } from "../api";
import type { Proposal, StatusView } from "../types";

afterEach(() => {
  cleanup();
});

const NOW = new Date().toISOString();

function stubStatus(): StatusView {
  return {
    env: { name: "test", home: "/tmp/test", adapter: null },
    events: {},
    proposals: { open: 2, expired: 0 },
    runs: { byState: {} },
    workers: { live: 1, busy: 0, stale: 0 },
    artifacts: { files: 0, bytes: 0, orphans: 0, orphanBytes: 0 },
    anomalies: {
      expiredOpenProposals: [],
      staleLeases: 0,
      unpublishedOutbox: 0,
      deadLettered: [],
      stalledWorkers: [],
      noWorkers: false,
      ambiguousOpenProposals: [],
    },
  };
}

function stubProposal(id: string, overrides: Partial<Proposal> = {}): Proposal {
  return {
    id,
    agent: "triage-scan",
    decision: "run",
    status: "open",
    runId: `run_${id}`,
    ttl_seconds: 600,
    expired: false,
    created_at: NOW,
    decided_at: null,
    decided_by: null,
    repos: ["factory"],
    eventId: "ev_1",
    eventSource: "github",
    reason: "Auto generated proposal",
    spec: {
      schemaVersion: "1",
      runId: `run_${id}`,
      agent: "triage-scan",
      input: { repo: "factory", branch: "main" },
      inputHash: "in-1",
      workspace: { type: "ephemeral" },
      adapter: "claude-code",
      promptVersion: "1",
      policyVersion: "1",
      outputContract: "triage/v1",
      capabilities: [],
      timeoutSeconds: 600,
      maxAttempts: 3,
      idempotencyKey: `idem-${id}`,
    },
    ...overrides,
  };
}

function renderWithClient(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const noop = () => {};

function renderProposals(props: Partial<Parameters<typeof Proposals>[0]> = {}) {
  return renderWithClient(
    <Proposals
      connected={true}
      context={{ kind: "all" }}
      onRunQueued={noop}
      focusProposalId={null}
      onSelectProposal={noop}
      focusExpired={false}
      onFocusExpiredConsumed={noop}
      onJumpAgent={noop}
      onJumpEvent={noop}
      {...props}
    />,
  );
}

function changeInput(el: HTMLElement, value: string) {
  const propsKey = Object.keys(el).find((k) => k.startsWith("__reactProps"))!;
  (el as any)[propsKey]?.onChange?.({ target: { value } });
}

describe("Proposals multi-row selection & bulk actions (WM-71)", () => {
  let origProposals: typeof api.proposals;
  let origProposalHistory: typeof api.proposalHistory;
  let origStatus: typeof api.status;
  let origRuns: typeof api.runs;
  let origEvents: typeof api.events;
  let origAgents: typeof api.agents;
  let origApprove: typeof api.approve;
  let origReject: typeof api.reject;

  beforeEach(() => {
    origProposals = api.proposals;
    origProposalHistory = api.proposalHistory;
    origStatus = api.status;
    origRuns = api.runs;
    origEvents = api.events;
    origAgents = api.agents;
    origApprove = api.approve;
    origReject = api.reject;

    api.status = async () => stubStatus();
    api.runs = async () => ({ runs: [] });
    api.events = async () => ({ events: [] });
    api.agents = async () => ({ agents: [], edges: {}, eventTypes: [], contracts: {} });
  });

  afterEach(() => {
    api.proposals = origProposals;
    api.proposalHistory = origProposalHistory;
    api.status = origStatus;
    api.runs = origRuns;
    api.events = origEvents;
    api.agents = origAgents;
    api.approve = origApprove;
    api.reject = origReject;
  });

  test("supports individual checkbox selection and renders floating bulk action bar", async () => {
    const p1 = stubProposal("prop_1", { agent: "triage-scan" });
    const p2 = stubProposal("prop_2", { agent: "security-scan" });
    api.proposals = async () => ({ proposals: [p1, p2] });
    api.proposalHistory = async () => ({ proposals: [] });

    const r = renderProposals();
    await waitFor(() => expect(r.getByLabelText("Select proposal prop_1")).toBeTruthy());

    // Initially no bulk action bar
    expect(r.queryByRole("toolbar", { name: /bulk actions/i })).toBeNull();

    // Select prop_1
    const cb1 = r.getByLabelText("Select proposal prop_1") as HTMLInputElement;
    expect(cb1.checked).toBe(false);
    fireEvent.click(cb1);
    expect(cb1.checked).toBe(true);

    // Floating bar appears with 1 selected
    expect(r.getByRole("toolbar", { name: /bulk actions/i })).toBeTruthy();
    expect(r.getByText("Approve selected (1)")).toBeTruthy();
    expect(r.getByText("Reject selected (1)")).toBeTruthy();

    // Select prop_2
    const cb2 = r.getByLabelText("Select proposal prop_2") as HTMLInputElement;
    fireEvent.click(cb2);
    expect(cb2.checked).toBe(true);

    expect(r.getByText("Approve selected (2)")).toBeTruthy();
    expect(r.getByText("Reject selected (2)")).toBeTruthy();

    // Clear selection
    const clearBtn = r.getByText("Clear");
    fireEvent.click(clearBtn);
    expect(r.queryByRole("toolbar", { name: /bulk actions/i })).toBeNull();
    expect(cb1.checked).toBe(false);
    expect(cb2.checked).toBe(false);
  });

  test("select all checkbox selects/deselects all visible proposals matching current filter", async () => {
    const p1 = stubProposal("prop_1", { agent: "triage-scan" });
    const p2 = stubProposal("prop_2", { agent: "security-scan" });
    api.proposals = async () => ({ proposals: [p1, p2] });
    api.proposalHistory = async () => ({ proposals: [] });

    const r = renderProposals();
    await waitFor(() => expect(r.getByLabelText("Select proposal prop_1")).toBeTruthy());

    const selectAll = r.getByLabelText("Select all proposals") as HTMLInputElement;
    expect(selectAll.checked).toBe(false);

    // Click select all
    fireEvent.click(selectAll);
    expect(selectAll.checked).toBe(true);
    expect(r.getByText("Approve selected (2)")).toBeTruthy();

    // Click select all again to deselect all
    fireEvent.click(selectAll);
    expect(selectAll.checked).toBe(false);
    expect(r.queryByRole("toolbar", { name: /bulk actions/i })).toBeNull();

    // Now filter by security using changeInput
    const filterInput = r.getByLabelText("Filter proposals") as HTMLInputElement;
    await act(async () => {
      changeInput(filterInput, "security");
    });

    expect(r.queryByLabelText("Select proposal prop_1")).toBeNull();
    expect(r.getByLabelText("Select proposal prop_2")).toBeTruthy();

    // Click select all under filter — only 1 matching row should be selected
    const selectAllAfter = r.getByLabelText("Select all proposals") as HTMLInputElement;
    fireEvent.click(selectAllAfter);
    expect(r.getByText("Approve selected (1)")).toBeTruthy();
  });

  test("bulk approve approves actionable proposals and skips non-actionable rows", async () => {
    const p1 = stubProposal("prop_1", { decision: "run" });
    const p2 = stubProposal("prop_2", { decision: "run" });
    const p3 = stubProposal("prop_3", { decision: "noop" }); // non-actionable for approval
    api.proposals = async () => ({ proposals: [p1, p2, p3] });
    api.proposalHistory = async () => ({ proposals: [] });

    const approvedIds: string[] = [];
    api.approve = async (id: string) => {
      approvedIds.push(id);
      return { approved: true, runId: `run_${id}`, proposal: undefined, replanned: false };
    };

    const r = renderProposals();
    await waitFor(() => expect(r.getByLabelText("Select proposal prop_1")).toBeTruthy());

    // Select all 3
    const selectAll = r.getByLabelText("Select all proposals");
    fireEvent.click(selectAll);

    // Click Approve selected (3)
    const approveBtn = r.getByText("Approve selected (3)");
    await act(async () => {
      fireEvent.click(approveBtn);
    });

    // Should have approved prop_1 and prop_2, skipping prop_3
    expect(approvedIds).toEqual(["prop_1", "prop_2"]);
    // Selection should be cleared
    expect(r.queryByRole("toolbar", { name: /bulk actions/i })).toBeNull();
  });

  test("bulk reject prompts once for reason and applies to all selected", async () => {
    const p1 = stubProposal("prop_1");
    const p2 = stubProposal("prop_2");
    api.proposals = async () => ({ proposals: [p1, p2] });
    api.proposalHistory = async () => ({ proposals: [] });

    const rejectedCalls: { id: string; why?: string }[] = [];
    api.reject = async (id: string, why?: string) => {
      rejectedCalls.push({ id, why });
      return { rejected: true };
    };

    const r = renderProposals();
    await waitFor(() => expect(r.getByLabelText("Select proposal prop_1")).toBeTruthy());

    // Select all 2
    const selectAll = r.getByLabelText("Select all proposals");
    fireEvent.click(selectAll);

    // Click Reject selected (2)
    const rejectBtn = r.getByText("Reject selected (2)");
    fireEvent.click(rejectBtn);

    // Prompt Dialog appears
    expect(r.getByRole("dialog")).toBeTruthy();
    expect(r.getByText(/Reject 2 selected proposals/i)).toBeTruthy();

    // Click a canned template
    const cannedScope = r.getByRole("button", { name: "Scope too wide" });
    fireEvent.click(cannedScope);

    // Confirm bulk rejection
    const confirmBtn = r.getByRole("button", { name: "Reject 2 proposals" });
    await act(async () => {
      fireEvent.click(confirmBtn);
    });

    expect(rejectedCalls).toEqual([
      { id: "prop_1", why: "Scope too wide" },
      { id: "prop_2", why: "Scope too wide" },
    ]);

    // Dialog closed and selection cleared
    expect(r.queryByRole("dialog")).toBeNull();
    expect(r.queryByRole("toolbar", { name: /bulk actions/i })).toBeNull();
  });

  test("selection clears on tab switch and history rows are not selectable", async () => {
    const pOpen = stubProposal("prop_open", { agent: "open-agent", status: "open" });
    const pHist = stubProposal("prop_hist", { agent: "hist-agent", status: "approved" });
    api.proposals = async () => ({ proposals: [pOpen] });
    api.proposalHistory = async () => ({ proposals: [pHist] });

    const r = renderProposals();
    await waitFor(() => expect(r.getByLabelText("Select proposal prop_open")).toBeTruthy());

    // Select open proposal
    const cb = r.getByLabelText("Select proposal prop_open");
    fireEvent.click(cb);
    expect(r.getByText("Approve selected (1)")).toBeTruthy();

    // Switch to History tab
    const historyTab = r.getByRole("tab", { name: /history/i });
    fireEvent.click(historyTab);

    await waitFor(() => {
      expect(r.getByText("hist-agent")).toBeTruthy();
    });

    // Selection cleared
    expect(r.queryByRole("toolbar", { name: /bulk actions/i })).toBeNull();

    // No checkboxes in History tab
    expect(r.queryByLabelText(/Select proposal/i)).toBeNull();
    expect(r.queryByLabelText("Select all proposals")).toBeNull();

    // Switch back to Open tab — selection remains cleared
    const openTab = r.getByRole("tab", { name: /open/i });
    fireEvent.click(openTab);

    await waitFor(() => {
      expect(r.getByText("open-agent")).toBeTruthy();
    });
    expect(r.queryByRole("toolbar", { name: /bulk actions/i })).toBeNull();
    const cbAfter = r.getByLabelText("Select proposal prop_open") as HTMLInputElement;
    expect(cbAfter.checked).toBe(false);
  });
});
