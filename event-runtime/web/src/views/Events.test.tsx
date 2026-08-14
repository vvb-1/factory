import "../test-dom";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { Events } from "./Events";
import {
  changeInput,
  createEventFixture,
  createStatusFixture,
  renderWithClient,
  restoreApi,
  withApi,
} from "../test-render";
import type { AdmittedEvent, EventFocus } from "../types";

afterEach(() => {
  cleanup();
  restoreApi();
  localStorage.clear();
});

const noop = () => {};
const NOW = new Date().toISOString();

function stubEvent(eventId: string, status: string, overrides?: Partial<AdmittedEvent>): AdmittedEvent {
  return createEventFixture({
    source: "github",
    eventId,
    type: "pull_request.opened",
    subject: "factory/test-repo",
    status,
    occurredAt: NOW,
    receivedAt: NOW,
    admittedAt: NOW,
    repos: ["repo-test"],
    ...overrides,
  });
}

function renderEvents(props: Partial<Parameters<typeof Events>[0]> = {}) {
  return renderWithClient(
    <Events
      connected={true}
      context={{ kind: "all" }}
      focusEvent={null}
      onFocusConsumed={noop}
      onSelectEvent={noop}
      onSelectType={noop}
      onJumpProposal={noop}
      onJumpRun={noop}
      onTriggerAgain={noop}
      onInject={noop}
      {...props}
    />,
  );
}

describe("Events component harness: selection & detail view", () => {
  test("clicking a row selects the event via onSelectEvent", async () => {
    const onSelectEvent = mock(() => {});
    const e1 = stubEvent("evt_click_test", "admitted");

    await withApi(
      {
        events: async () => ({ events: [e1] }),
        status: async () => createStatusFixture(),
      },
      async () => {
        const { getByText } = renderEvents({ onSelectEvent });

        const cell = await waitFor(() => getByText("evt_click_test"));
        const row = cell.closest("tr");
        expect(row).toBeTruthy();
        fireEvent.click(row!);

        expect(onSelectEvent).toHaveBeenCalledWith("github", "evt_click_test");
      },
    );
  });

  test("focusEvent highlights the selected row and renders event detail panel", async () => {
    const e1 = stubEvent("evt_selected_1", "admitted", {
      type: "custom.event.type",
      subject: "Test subject payload",
    });

    await withApi(
      {
        events: async () => ({ events: [e1] }),
        status: async () => createStatusFixture(),
      },
      async () => {
        const focusEvent: EventFocus = { source: "github", eventId: "evt_selected_1" };
        const { container, getAllByText } = renderEvents({ focusEvent });

        const selectedRow = await waitFor(() => {
          const el = container.querySelector("tr.row-selected");
          if (!el) throw new Error("selected row not highlighted");
          return el;
        });
        expect(selectedRow).toBeTruthy();

        // Detail pane renders event metadata
        await waitFor(() => {
          expect(getAllByText("custom.event.type").length).toBeGreaterThan(0);
        });
      },
    );
  });

  test("switching status tabs clears row selection via onSelectEvent(null)", async () => {
    const onSelectEvent = mock(() => {});
    const e1 = stubEvent("evt_tab_1", "admitted");

    await withApi(
      {
        events: async () => ({ events: [e1] }),
        status: async () => createStatusFixture(),
      },
      async () => {
        const focusEvent: EventFocus = { source: "github", eventId: "evt_tab_1" };
        const { getByRole, container } = renderEvents({ focusEvent, onSelectEvent });

        await waitFor(() => container.querySelector("tr.row-selected"));

        const plannedTab = getByRole("tab", { name: /^Planned/i });
        fireEvent.click(plannedTab);

        expect(onSelectEvent).toHaveBeenCalledWith(null);
      },
    );
  });
});

describe("Events component harness: filter retention", () => {
  test("typing in filter input restricts visible events and retains matching selection", async () => {
    const e1 = stubEvent("evt_pr_opened", "admitted", { type: "pull_request.opened" });
    const e2 = stubEvent("evt_pr_closed", "admitted", { type: "pull_request.closed" });

    await withApi(
      {
        events: async () => ({ events: [e1, e2] }),
        status: async () => createStatusFixture(),
      },
      async () => {
        const focusEvent: EventFocus = { source: "github", eventId: "evt_pr_opened" };
        const { getByLabelText, container } = renderEvents({ focusEvent });

        await waitFor(() => container.querySelector("tr.row-selected"));
        expect(container.querySelector("tbody")?.textContent).toContain("evt_pr_closed");

        const filterInput = getByLabelText("Filter events") as HTMLInputElement;
        act(() => {
          changeInput(filterInput, "type:pull_request.opened");
        });

        await waitFor(() => {
          expect(container.querySelector("tbody")?.textContent).toContain("evt_pr_opened");
          expect(container.querySelector("tbody")?.textContent).not.toContain("evt_pr_closed");
        });

        // Selected event remains highlighted
        const selectedRow = container.querySelector("tr.row-selected");
        expect(selectedRow).toBeTruthy();
        expect(selectedRow?.textContent).toContain("evt_pr_opened");
      },
    );
  });
});

describe("Events component harness: cross-tab reveal", () => {
  test("switches tab to All when focusEvent points to an event in a different status", async () => {
    const eAdmitted = stubEvent("evt_admitted_1", "admitted");
    const eDead = stubEvent("evt_dead_lettered_1", "dead_lettered");
    const allEvents = [eAdmitted, eDead];

    await withApi(
      {
        events: async (status?: string) => ({
          events: status && status !== "all" ? allEvents.filter((e) => e.status === status) : allEvents,
        }),
        status: async () => createStatusFixture(),
      },
      async () => {
        const onFocusConsumed = mock(() => {});
        // Start on admitted tab via focusEvent with status
        const { getByRole, container, rerender } = renderEvents({
          focusEvent: { status: "admitted" },
          onFocusConsumed,
        });

        await waitFor(() => {
          const tab = getByRole("tab", { name: /^Admitted/i });
          expect(tab.getAttribute("aria-selected")).toBe("true");
          expect(onFocusConsumed).toHaveBeenCalled();
        });

        // Now focus the dead_lettered event
        rerender(
          <Events
            connected={true}
            context={{ kind: "all" }}
            focusEvent={{ source: "github", eventId: "evt_dead_lettered_1" }}
            onFocusConsumed={noop}
            onSelectEvent={noop}
            onSelectType={noop}
            onJumpProposal={noop}
            onJumpRun={noop}
            onTriggerAgain={noop}
            onInject={noop}
          />,
        );

        // Should switch to All tab and render the dead_lettered event
        await waitFor(() => {
          const allTab = getByRole("tab", { name: /^All/i });
          expect(allTab.getAttribute("aria-selected")).toBe("true");
          expect(container.querySelector("tbody")?.textContent).toContain("evt_dead_lettered_1");
        });
      },
    );
  });

  test("clears active text filter when focusEvent is hidden by the filter", async () => {
    const e1 = stubEvent("evt_1", "admitted", { type: "pull_request.opened" });
    const e2 = stubEvent("evt_2", "admitted", { type: "issue_comment.created" });

    await withApi(
      {
        events: async () => ({ events: [e1, e2] }),
        status: async () => createStatusFixture(),
      },
      async () => {
        const { getByLabelText, container, rerender } = renderEvents({});

        await waitFor(() => {
          expect(container.querySelector("tbody")?.textContent).toContain("evt_1");
        });

        // Filter for type pull_request, hiding evt_2
        const filterInput = getByLabelText("Filter events") as HTMLInputElement;
        act(() => {
          changeInput(filterInput, "type:pull_request.opened");
        });

        await waitFor(() => {
          expect(container.querySelector("tbody")?.textContent).not.toContain("evt_2");
        });

        // Focus evt_2 (which was hidden by the filter)
        rerender(
          <Events
            connected={true}
            context={{ kind: "all" }}
            focusEvent={{ source: "github", eventId: "evt_2" }}
            onFocusConsumed={noop}
            onSelectEvent={noop}
            onSelectType={noop}
            onJumpProposal={noop}
            onJumpRun={noop}
            onTriggerAgain={noop}
            onInject={noop}
          />,
        );

        // Filter should be cleared to reveal evt_2
        await waitFor(() => {
          const input = getByLabelText("Filter events") as HTMLInputElement;
          expect(input.value).toBe("");
          expect(container.querySelector("tbody")?.textContent).toContain("evt_2");
        });
      },
    );
  });

  test("retains active text filter when focusEvent is already visible under that filter", async () => {
    const e1 = stubEvent("evt_1", "admitted", { source: "github" });
    const e2 = stubEvent("evt_2", "admitted", { source: "github" });

    await withApi(
      {
        events: async () => ({ events: [e1, e2] }),
        status: async () => createStatusFixture(),
      },
      async () => {
        const { getByLabelText, container, rerender } = renderEvents({});

        await waitFor(() => {
          expect(container.querySelector("tbody")?.textContent).toContain("evt_1");
        });

        const filterInput = getByLabelText("Filter events") as HTMLInputElement;
        act(() => {
          changeInput(filterInput, "source:github");
        });

        await waitFor(() => {
          expect(container.querySelector("tbody")?.textContent).toContain("evt_1");
        });

        // Focus evt_1 (already visible under source:github)
        rerender(
          <Events
            connected={true}
            context={{ kind: "all" }}
            focusEvent={{ source: "github", eventId: "evt_1" }}
            onFocusConsumed={noop}
            onSelectEvent={noop}
            onSelectType={noop}
            onJumpProposal={noop}
            onJumpRun={noop}
            onTriggerAgain={noop}
            onInject={noop}
          />,
        );

        // Filter is retained
        await waitFor(() => {
          const input = getByLabelText("Filter events") as HTMLInputElement;
          expect(input.value).toBe("source:github");
          expect(container.querySelector("tbody")?.textContent).toContain("evt_1");
        });
      },
    );
  });

  test("ephemeral focusEvent with status/type updates tab and calls onFocusConsumed", async () => {
    const onFocusConsumed = mock(() => {});
    await withApi(
      {
        events: async () => ({ events: [] }),
        status: async () => createStatusFixture(),
      },
      async () => {
        const { getByRole } = renderEvents({
          focusEvent: { status: "planned", type: "custom.type" },
          onFocusConsumed,
        });

        await waitFor(() => {
          const tab = getByRole("tab", { name: /^Planned/i });
          expect(tab.getAttribute("aria-selected")).toBe("true");
          expect(onFocusConsumed).toHaveBeenCalled();
        });
      },
    );
  });
});
