import "../test-dom";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { api, type PanelView } from "../api";
import { renderWithClient, withApi } from "../test-render";
import { PanelGrid } from "./PanelGrid";

afterEach(() => {
  cleanup();
});

const ENDPOINTS = ["/inbox", "/proposals", "/status", "/tickets"];

/** The built-in panel, exactly as the runtime serves it (minus origin/file which /panels adds). */
const BUILTIN = JSON.parse(
  readFileSync(
    path.resolve(import.meta.dir, "../../../panels/inbox-open.panel.json"),
    "utf8",
  ),
);

function panel(overrides: Partial<PanelView> = {}): PanelView {
  return {
    name: BUILTIN.name,
    title: BUILTIN.title,
    description: BUILTIN.description,
    source: BUILTIN.source,
    refreshSeconds: BUILTIN.refreshSeconds,
    view: BUILTIN.view,
    origin: "builtin",
    file: "panels/inbox-open.panel.json",
    ...overrides,
  };
}

const inboxItems = [
  {
    id: "inbox_1",
    kind: "BLOCKED",
    severity: "high",
    title: "WM-1 needs a decision",
    createdAt: "2026-08-18T09:00:00.000Z",
  },
  {
    id: "inbox_2",
    kind: "RC READY",
    severity: "normal",
    title: "factory develop → main",
    createdAt: "2026-08-18T08:00:00.000Z",
  },
];

describe("PanelGrid (WM-840)", () => {
  test("renders nothing when the catalogue has no panels — no empty section", async () => {
    await withApi(
      { panels: async () => ({ panels: [], endpoints: ENDPOINTS }) },
      async () => {
        const { container } = renderWithClient(<PanelGrid />);
        await waitFor(() => expect(api.panels).toHaveBeenCalled());
        expect(container.querySelector('[aria-label="Panels"]')).toBeNull();
        expect(container.textContent).toBe("");
        expect(api.panelSource).not.toHaveBeenCalled();
      },
    );
  });

  test("renders nothing when the catalogue itself cannot be read", async () => {
    await withApi(
      {
        panels: async () => {
          throw new Error("HTTP 500");
        },
      },
      async () => {
        const { container } = renderWithClient(<PanelGrid />);
        await waitFor(() => expect(api.panels).toHaveBeenCalled());
        await new Promise((r) => setTimeout(r, 20));
        expect(container.querySelector('[aria-label="Panels"]')).toBeNull();
      },
    );
  });

  test("fetches each panel's source with its query, applies source.path and draws the node with ArtifactView", async () => {
    await withApi(
      {
        panels: async () => ({ panels: [panel()], endpoints: ENDPOINTS }),
        panelSource: async (
          endpoint: string,
          query?: Record<string, string>,
        ) => {
          expect(endpoint).toBe("/inbox");
          expect(query).toEqual({ status: "open" });
          return { items: inboxItems };
        },
      },
      async () => {
        const { container, findByLabelText, findByText } = renderWithClient(
          <PanelGrid />,
        );
        const grid = await findByLabelText("Panels");
        expect(within(grid).getByText("Open inbox items")).toBeTruthy();
        expect(within(grid).getByText("builtin")).toBeTruthy();
        expect(
          within(grid).getByText("1 · from packs and extensions"),
        ).toBeTruthy();
        // The table over /items, with the panel's columns and tones.
        await findByText("WM-1 needs a decision");
        const tile = container.querySelector('[data-panel="inbox-open"]')!;
        expect(tile.querySelector("[data-artifact-view]")).not.toBeNull();
        expect(within(tile as HTMLElement).getByText("BLOCKED")).toBeTruthy();
        expect(within(tile as HTMLElement).getByText("RC READY")).toBeTruthy();
        expect(tile.textContent).toContain("as of ");
        expect(api.panelSource).toHaveBeenCalledTimes(1);
      },
    );
  });

  test("a panel whose fetch fails shows an inline error tile with Retry and never breaks the grid", async () => {
    let attempts = 0;
    await withApi(
      {
        panels: async () => ({
          panels: [
            panel(),
            panel({
              name: "wattmind/mobile:blocked",
              title: "Blocked > 24h",
              origin: "extension:wattmind/mobile",
              file: "panels/blocked.panel.json",
              source: {
                endpoint: "/tickets",
                query: { state: "blocked" },
                path: "/tickets",
              },
              view: {
                sections: [
                  {
                    path: "",
                    as: "table",
                    columns: ["identifier", "title"],
                    formats: { identifier: "issue" },
                  },
                ],
              },
            }),
          ],
          endpoints: ENDPOINTS,
        }),
        panelSource: async (endpoint: string) => {
          if (endpoint === "/tickets") {
            attempts += 1;
            if (attempts === 1) throw new Error("HTTP 503");
            return { tickets: [{ identifier: "WM-9", title: "Stuck ticket" }] };
          }
          return { items: inboxItems };
        },
      },
      async () => {
        const { container, findByRole, findByText } = renderWithClient(
          <PanelGrid />,
        );
        // The healthy tile draws; the failing tile reports inline.
        await findByText("WM-1 needs a decision");
        const alert = await findByRole("alert");
        expect(alert.textContent).toContain("Panel failed:");
        expect(alert.textContent).toContain("HTTP 503");
        expect(alert.textContent).toContain("/tickets");
        const failed = container.querySelector(
          '[data-panel="wattmind/mobile:blocked"]',
        )!;
        expect(
          within(failed as HTMLElement).getByText("Blocked > 24h"),
        ).toBeTruthy();
        expect(
          within(failed as HTMLElement).getByText("extension:wattmind/mobile"),
        ).toBeTruthy();
        expect(container.querySelectorAll("[data-panel]")).toHaveLength(2);
        // Retry refetches just that panel and the tile recovers.
        fireEvent.click(within(failed as HTMLElement).getByText("Retry"));
        await findByText("Stuck ticket");
        expect(container.querySelector('[role="alert"]')).toBeNull();
        expect(attempts).toBe(2);
      },
    );
  });

  test("a panel whose pointer misses, or whose data is empty, says so instead of drawing nothing", async () => {
    await withApi(
      {
        panels: async () => ({
          panels: [
            panel(),
            panel({
              name: "other",
              title: "Other",
              source: { endpoint: "/status", query: {}, path: "/nope/deeper" },
            }),
          ],
          endpoints: ENDPOINTS,
        }),
        panelSource: async (endpoint: string) =>
          endpoint === "/inbox" ? { items: [] } : { workers: {} },
      },
      async () => {
        const { findByText } = renderWithClient(<PanelGrid />);
        await findByText("Nothing to show — empty.");
        const miss = await findByText(/Nothing at/);
        expect(miss.textContent).toContain("/nope/deeper");
        expect(miss.textContent).toContain("/status");
      },
    );
  });

  test("refuses client-side to fetch an endpoint the runtime did not allow-list", async () => {
    await withApi(
      {
        panels: async () => ({
          panels: [
            panel({
              source: { endpoint: "/inbox", query: {}, path: "/items" },
            }),
          ],
          endpoints: ["/status"],
        }),
        panelSource: mock(async () => ({ items: inboxItems })),
      },
      async () => {
        const { findByRole } = renderWithClient(<PanelGrid />);
        const alert = await findByRole("alert");
        expect(alert.textContent).toContain("not allow-listed");
        expect(api.panelSource).not.toHaveBeenCalled();
      },
    );
  });
});
