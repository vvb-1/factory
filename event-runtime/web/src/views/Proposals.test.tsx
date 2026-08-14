import "../test-dom";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { Proposals } from "./Proposals";
import {
  changeInput,
  createProposalFixture,
  createStatusFixture,
  renderWithClient,
  restoreApi,
  withApi,
} from "../test-render";
import type { Proposal } from "../types";

afterEach(() => {
  cleanup();
  restoreApi();
  localStorage.clear();
});

const noop = () => {};
const NOW = new Date().toISOString();

function stubProposal(id: string, status = "open", overrides?: Partial<Proposal>): Proposal {
  return createProposalFixture({
    id,
    decision: "run",
    status,
    expired: false,
    created_at: NOW,
    ttl_seconds: 300,
    agent: "triage-scan",
    repos: ["repo-test"],
    ...overrides,
  });
}

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

describe("Proposals component harness: selection & detail view", () => {
  test("clicking a row selects the proposal via onSelectProposal", async () => {
    const onSelectProposal = mock(() => {});
    const p1 = stubProposal("prop_click_test", "open", { agent: "agent-click-test" });

    await withApi(
      {
        proposals: async () => ({ proposals: [p1] }),
        status: async () => createStatusFixture(),
        runs: async () => ({ runs: [] }),
        events: async () => ({ events: [] }),
      },
      async () => {
        const { getByText } = renderProposals({ onSelectProposal });

        const cell = await waitFor(() => getByText("agent-click-test"));
        const row = cell.closest("tr");
        expect(row).toBeTruthy();
        fireEvent.click(row!);

        expect(onSelectProposal).toHaveBeenCalledWith("prop_click_test");
      },
    );
  });

  test("focusProposalId highlights the selected row and renders the spec detail panel", async () => {
    const p1 = stubProposal("prop_selected_1", "open", {
      agent: "triage-scan",
      reason: "Needs triage review",
    });

    await withApi(
      {
        proposals: async () => ({ proposals: [p1] }),
        status: async () => createStatusFixture(),
        runs: async () => ({ runs: [] }),
        events: async () => ({ events: [] }),
      },
      async () => {
        const { container, getAllByText } = renderProposals({ focusProposalId: "prop_selected_1" });

        const selectedRow = await waitFor(() => {
          const el = container.querySelector("tr.row-selected");
          if (!el) throw new Error("selected row not highlighted");
          return el;
        });
        expect(selectedRow).toBeTruthy();

        // Detail pane renders reason and proposal id
        await waitFor(() => {
          expect(getAllByText("prop_selected_1").length).toBeGreaterThan(0);
          expect(getAllByText("Needs triage review").length).toBeGreaterThan(0);
        });
      },
    );
  });
});

describe("Proposals component harness: filter retention", () => {
  test("typing in filter input restricts visible proposals and retains matching selection", async () => {
    const p1 = stubProposal("prop_alpha", "open", { agent: "triage-scan" });
    const p2 = stubProposal("prop_beta", "open", { agent: "review-scan" });

    await withApi(
      {
        proposals: async () => ({ proposals: [p1, p2] }),
        status: async () => createStatusFixture(),
        runs: async () => ({ runs: [] }),
        events: async () => ({ events: [] }),
      },
      async () => {
        const { getByLabelText, container } = renderProposals({ focusProposalId: "prop_alpha" });

        await waitFor(() => container.querySelector("tr.row-selected"));
        expect(container.querySelector("tbody")?.textContent).toContain("review-scan");

        const filterInput = getByLabelText("Filter proposals") as HTMLInputElement;
        act(() => {
          changeInput(filterInput, "agent:triage-scan");
        });

        await waitFor(() => {
          expect(container.querySelector("tbody")?.textContent).toContain("triage-scan");
          expect(container.querySelector("tbody")?.textContent).not.toContain("review-scan");
        });

        // Selected proposal remains highlighted
        const selectedRow = container.querySelector("tr.row-selected");
        expect(selectedRow).toBeTruthy();
      },
    );
  });
});

describe("Proposals component harness: cross-tab reveal", () => {
  test("switches tab to History when focusProposalId is a decided proposal", async () => {
    const pOpen = stubProposal("prop_open_1", "open", { agent: "agent-open" });
    const pDecided = stubProposal("prop_decided_1", "approved", {
      agent: "agent-decided",
      decided_at: NOW,
      decided_by: "operator",
    });

    await withApi(
      {
        proposals: async () => ({ proposals: [pOpen] }),
        proposalHistory: async () => ({ proposals: [pDecided] }),
        status: async () => createStatusFixture(),
        runs: async () => ({ runs: [] }),
        events: async () => ({ events: [] }),
      },
      async () => {
        // Start on Open tab with no selection
        const { getByRole, container, rerender } = renderProposals({});

        await waitFor(() => {
          const openTab = getByRole("tab", { name: /^Open/i });
          expect(openTab.getAttribute("aria-selected")).toBe("true");
        });

        // Focus the decided proposal
        rerender(
          <Proposals
            connected={true}
            context={{ kind: "all" }}
            onRunQueued={noop}
            focusProposalId="prop_decided_1"
            onSelectProposal={noop}
            focusExpired={false}
            onFocusExpiredConsumed={noop}
            onJumpAgent={noop}
            onJumpEvent={noop}
          />,
        );

        // Should switch to History tab and render the decided proposal
        await waitFor(() => {
          const historyTab = getByRole("tab", { name: /^History/i });
          expect(historyTab.getAttribute("aria-selected")).toBe("true");
          expect(container.querySelector("tbody")?.textContent).toContain("agent-decided");
        });
      },
    );
  });

  test("clears active text filter when focusProposalId is hidden by the filter", async () => {
    const p1 = stubProposal("prop_1", "open", { agent: "triage-scan" });
    const p2 = stubProposal("prop_2", "open", { agent: "review-scan" });

    await withApi(
      {
        proposals: async () => ({ proposals: [p1, p2] }),
        status: async () => createStatusFixture(),
        runs: async () => ({ runs: [] }),
        events: async () => ({ events: [] }),
      },
      async () => {
        const { getByLabelText, container, rerender } = renderProposals({});

        await waitFor(() => {
          expect(container.querySelector("tbody")?.textContent).toContain("triage-scan");
        });

        // Filter for agent triage, hiding prop_2
        const filterInput = getByLabelText("Filter proposals") as HTMLInputElement;
        act(() => {
          changeInput(filterInput, "agent:triage-scan");
        });

        await waitFor(() => {
          expect(container.querySelector("tbody")?.textContent).not.toContain("review-scan");
        });

        // Focus prop_2 (which was hidden by the filter)
        rerender(
          <Proposals
            connected={true}
            context={{ kind: "all" }}
            onRunQueued={noop}
            focusProposalId="prop_2"
            onSelectProposal={noop}
            focusExpired={false}
            onFocusExpiredConsumed={noop}
            onJumpAgent={noop}
            onJumpEvent={noop}
          />,
        );

        // Filter should be cleared to reveal prop_2
        await waitFor(() => {
          const input = getByLabelText("Filter proposals") as HTMLInputElement;
          expect(input.value).toBe("");
          expect(container.querySelector("tbody")?.textContent).toContain("review-scan");
        });
      },
    );
  });

  test("retains active text filter when focusProposalId is already visible under that filter", async () => {
    const p1 = stubProposal("prop_1", "open", { agent: "triage-scan" });
    const p2 = stubProposal("prop_2", "open", { agent: "triage-scan" });

    await withApi(
      {
        proposals: async () => ({ proposals: [p1, p2] }),
        status: async () => createStatusFixture(),
        runs: async () => ({ runs: [] }),
        events: async () => ({ events: [] }),
      },
      async () => {
        const { getByLabelText, container, rerender } = renderProposals({});

        await waitFor(() => {
          expect(container.querySelector("tbody")?.textContent).toContain("triage-scan");
        });

        const filterInput = getByLabelText("Filter proposals") as HTMLInputElement;
        act(() => {
          changeInput(filterInput, "agent:triage-scan");
        });

        await waitFor(() => {
          expect(container.querySelector("tbody")?.textContent).toContain("triage-scan");
        });

        // Focus prop_1 (already visible under agent:triage-scan)
        rerender(
          <Proposals
            connected={true}
            context={{ kind: "all" }}
            onRunQueued={noop}
            focusProposalId="prop_1"
            onSelectProposal={noop}
            focusExpired={false}
            onFocusExpiredConsumed={noop}
            onJumpAgent={noop}
            onJumpEvent={noop}
          />,
        );

        // Filter is retained
        await waitFor(() => {
          const input = getByLabelText("Filter proposals") as HTMLInputElement;
          expect(input.value).toBe("agent:triage-scan");
          expect(container.querySelector("tbody")?.textContent).toContain("triage-scan");
        });
      },
    );
  });

  test("focusExpired prop sets open tab, filters to expired proposals, and calls onFocusExpiredConsumed", async () => {
    const onFocusExpiredConsumed = mock(() => {});
    const pExpired = stubProposal("prop_exp", "open", { expired: true, agent: "agent-expired" });
    const pActive = stubProposal("prop_act", "open", { expired: false, agent: "agent-active" });

    await withApi(
      {
        proposals: async () => ({ proposals: [pExpired, pActive] }),
        status: async () => createStatusFixture({ proposals: { open: 2, expired: 1 } }),
        runs: async () => ({ runs: [] }),
        events: async () => ({ events: [] }),
      },
      async () => {
        const { getByRole, container } = renderProposals({
          focusExpired: true,
          onFocusExpiredConsumed,
        });

        await waitFor(() => {
          const openTab = getByRole("tab", { name: /^Open/i });
          expect(openTab.getAttribute("aria-selected")).toBe("true");
          expect(onFocusExpiredConsumed).toHaveBeenCalled();
          expect(container.querySelector("tbody")?.textContent).toContain("agent-expired");
          expect(container.querySelector("tbody")?.textContent).not.toContain("agent-active");
        });
      },
    );
  });
});
