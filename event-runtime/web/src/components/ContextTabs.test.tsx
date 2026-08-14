import "../test-dom";
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import type { RepoItem } from "../types";
import { ContextTabs } from "./ContextTabs";

function repo(name: string): RepoItem {
  return {
    name,
    path: `/tmp/${name}`,
    github: null,
    team: null,
    project: null,
    base: "develop",
    deployBranch: null,
    reportOnly: false,
    maxInFlight: null,
    worktreeRoot: null,
    hasWorktreeUp: false,
    hasWorktreeDown: false,
    hasWorktreeWarm: false,
    verify: null,
  };
}

afterEach(() => {
  cleanup();
});

describe("ContextTabs", () => {
  test("renders role='toolbar' with aria-label='Context' and no tablist or tab roles", () => {
    const r = render(
      <ContextTabs
        repos={[repo("factory")]}
        reposError={false}
        openRepos={["factory"]}
        active={{ kind: "repo", name: "factory" }}
        onSelect={() => {}}
        onOpen={() => {}}
        onClose={() => {}}
      />,
    );

    expect(r.getAllByRole("toolbar")).toHaveLength(1);
    expect(r.getByRole("toolbar", { name: "Context" })).toBeDefined();
    expect(r.queryByRole("tablist")).toBeNull();
    expect(r.queryByRole("tab")).toBeNull();

    const pressed = r.getAllByRole("button").filter((el) => el.getAttribute("aria-pressed") === "true");
    expect(pressed).toHaveLength(1);
    expect(pressed[0].textContent).toBe("factory");

    const closeBtn = r.getByRole("button", { name: "Close factory" });
    expect(closeBtn.getAttribute("tabindex")).toBe("-1");
  });
});
