import "../test-dom";
import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { InjectDialog } from "./InjectDialog";
import { api } from "../api";
import type { AgentsView } from "../types";

afterEach(() => {
  cleanup();
});

function renderWithClient(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

function changeInput(el: HTMLElement, value: string) {
  const propsKey = Object.keys(el).find((k) => k.startsWith("__reactProps"))!;
  (el as any)[propsKey]?.onChange?.({ target: { value } });
}

describe("InjectDialog template selection sync (OPS-344)", () => {
  test("clicking highlighted fallback blank chip does not wipe envelope textarea", async () => {
    // Mock api.agents to return sample templates
    const origAgents = api.agents;
    api.agents = async () =>
      ({
        agents: [
          {
            ref: "worker@1",
            id: "worker",
            version: 1,
            outputContract: "c/v1",
            workspace: { type: "ephemeral" as const },
            capabilities: {},
            limits: {},
            mutating: false,
            promptFile: "",
            prompt: "",
            inputSchemaFile: "",
            inputSchema: {},
            outputSchemaFile: "",
            outputSchema: {},
            pins: {},
            command: null,
            actionRegistry: null,
            hosts: null,
            eventTypes: [],
          },
        ],
        eventTypes: [
          { type: "worker.started", agent: "worker@1", adapter: "cmd", idempotencyScope: [], proposalTtlSeconds: null },
          { type: "worker.stopped", agent: "worker@1", adapter: "cmd", idempotencyScope: [], proposalTtlSeconds: null },
        ],
        edges: {},
        contracts: {},
        schemaHash: "hash123",
        publishedAt: new Date().toISOString(),
      }) as unknown as AgentsView;

    try {
      const r = renderWithClient(<InjectDialog onClose={() => {}} />);
      // Wait for template to appear
      const templateChip = await r.findByRole("radio", { name: /worker\.started/i });
      expect(templateChip).toBeTruthy();

      // Click worker.started template
      act(() => {
        fireEvent.click(templateChip);
      });
      expect(templateChip.getAttribute("aria-checked")).toBe("true");

      const textarea = r.getByLabelText(/event envelope json/i) as HTMLTextAreaElement;
      expect(textarea.value).toContain('"worker.started"');

      // Edit textarea to simulate custom edits
      act(() => {
        changeInput(textarea, '{\n  "custom": "value",\n  "type": "worker.started"\n}');
      });
      expect(textarea.value).toContain('"custom": "value"');

      // Filter templates with search so worker.started vanishes
      const searchInput = r.getByPlaceholderText(/search/i) as HTMLInputElement;
      act(() => {
        changeInput(searchInput, "nonexistent");
      });

      // The blank chip is now checked as the fallback tabbable radio
      const blankChip = r.getByRole("radio", { name: /blank envelope/i });
      expect(blankChip.getAttribute("aria-checked")).toBe("true");
      expect(blankChip.getAttribute("tabindex")).toBe("0");

      // Clicking the already-highlighted blank chip must NOT wipe the custom textarea edits
      act(() => {
        fireEvent.click(blankChip);
      });
      expect(textarea.value).toContain('"custom": "value"');
      expect(textarea.value).toContain('"worker.started"');

      // Clear search so worker.started is visible again
      act(() => {
        changeInput(searchInput, "");
      });
      const workerStoppedChip = r.getByRole("radio", { name: /worker\.stopped/i });

      // Explicitly clicking another template updates text
      act(() => {
        fireEvent.click(workerStoppedChip);
      });
      expect(textarea.value).toContain('"worker.stopped"');

      // Explicitly clicking blank envelope now resets to blank starter
      act(() => {
        fireEvent.click(blankChip);
      });
      expect(textarea.value).toContain('"type": ""');
    } finally {
      api.agents = origAgents;
    }
  });
});
