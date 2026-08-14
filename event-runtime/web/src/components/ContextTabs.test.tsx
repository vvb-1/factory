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
  test("renders exactly one tablist and one selected tab for a given active context", () => {
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

    expect(r.getAllByRole("tablist")).toHaveLength(1);
    const selected = r.getAllByRole("tab").filter((el) => el.getAttribute("aria-selected") === "true");
    expect(selected).toHaveLength(1);
    expect(selected[0].textContent).toBe("factory");
  });
});
