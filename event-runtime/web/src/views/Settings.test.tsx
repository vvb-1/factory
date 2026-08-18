import "../test-dom";
import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { useState } from "react";
import type { ConfigView } from "../api";
import { changeInput, renderWithClient } from "../test-render";
import { Settings } from "./Settings";

const fixture: ConfigView = {
  generatedAt: "2026-08-18T10:00:00.000Z",
  policyVersion: "git:wm704",
  registry: {
    loadedAt: "2026-08-18T09:59:00.000Z",
    agentCount: 2,
    eventTypeCount: 3,
    edgeCount: 1,
    scheduleCount: 1,
  },
  sections: [
    {
      id: "repos",
      title: "Repositories",
      source: { file: "config/repos.yaml", kind: "yaml" },
      reload: "hot",
      entries: [
        {
          key: "factory.tools.base",
          value: "develop",
          note: "Repository factory.tools",
        },
      ],
    },
    {
      id: "policy",
      title: "Policy",
      source: { file: "config/policy.yaml", kind: "yaml" },
      reload: "hot",
      entries: [
        { key: "workers", value: { max: 20 } },
        {
          key: "models",
          value: { pi: { standard: "provider/needle-model" } },
          reload: "restart",
        },
        { key: "notify", value: null },
      ],
    },
    {
      id: "nodes",
      title: "Nodes",
      source: { file: "config/nodes.yaml", kind: "yaml" },
      reload: "cli-only",
      entries: [{ key: "lab.env.keys", value: ["FACTORY_PORT"] }],
    },
    {
      id: "schedule",
      title: "Schedule",
      source: { file: "config/schedule.yaml", kind: "yaml" },
      reload: "cli-only",
      entries: [],
    },
    {
      id: "registry",
      title: "Registry",
      source: { file: "event-runtime/*.json", kind: "registry" },
      reload: "restart",
      entries: [
        { key: "agents", value: 2 },
        { key: "schedules", value: 1 },
      ],
    },
  ],
};

const originalFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

function stubConfig() {
  globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) =>
    new Response(JSON.stringify(fixture), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

function StatefulSettings({ initial = null }: { initial?: string | null }) {
  const [section, setSection] = useState(initial);
  return <Settings focusSectionId={section} onSelectSection={setSection} />;
}

describe("Settings", () => {
  test("renders the section tree, counts, header metadata, and source/reload chips", async () => {
    stubConfig();
    const view = renderWithClient(<StatefulSettings initial="policy" />);
    await view.findByText("workers");

    expect(
      view.getByRole("navigation", { name: "Settings sections" }),
    ).toBeTruthy();
    expect(
      view
        .getByRole("button", { name: /Policy\s*3/ })
        .getAttribute("aria-current"),
    ).toBe("page");
    expect(view.getByText("git:wm704")).toBeTruthy();
    expect(view.getByText("2026-08-18T09:59:00.000Z")).toBeTruthy();
    expect(view.getAllByText("policy.yaml").length).toBeGreaterThan(0);
    expect(view.getByText("restart").title).toContain("restart serve");
    const hot = view.getAllByText("hot")[0];
    expect(hot.title).toContain("no serve restart");
    expect(hot.getAttribute("tabindex")).toBe("0");
    expect(hot.getAttribute("aria-label")).toContain("no serve restart");
  });

  test("searches keys and values across every section", async () => {
    stubConfig();
    const view = renderWithClient(<StatefulSettings initial="repos" />);
    await view.findByText("factory.tools.base");

    act(() =>
      changeInput(
        view.getByRole("combobox", { name: "Search settings" }),
        "needle-model",
      ),
    );
    await waitFor(() => expect(view.getByText("models")).toBeTruthy());
    expect(view.queryByText("factory.tools.base")).toBeNull();
    expect(view.getByRole("heading", { name: "Policy" })).toBeTruthy();
  });

  test("honours a deep-linked section and links repos and registry summaries to their owner views", async () => {
    stubConfig();
    const view = renderWithClient(<StatefulSettings initial="registry" />);
    const agents = await view.findByRole("link", { name: "agents" });
    expect(agents.getAttribute("href")).toBe("#/agents");
    expect(
      view.getByRole("link", { name: "schedules" }).getAttribute("href"),
    ).toBe("#/schedules");

    fireEvent.click(view.getByRole("button", { name: /Repositories\s*1/ }));
    const repo = await view.findByRole("link", { name: "factory.tools.base" });
    expect(repo.getAttribute("href")).toBe("#/projects/factory.tools");
  });

  test("redirects an unknown section to the first section and uses the shared empty placeholder", async () => {
    stubConfig();
    const view = renderWithClient(<StatefulSettings initial="missing" />);
    await waitFor(() =>
      expect(
        view
          .getByRole("button", { name: /Repositories\s*1/ })
          .getAttribute("aria-current"),
      ).toBe("page"),
    );

    fireEvent.click(view.getByRole("button", { name: /Policy\s*3/ }));
    expect(await view.findByText("notify")).toBeTruthy();
    expect(view.getByText("—")).toBeTruthy();
  });
});
