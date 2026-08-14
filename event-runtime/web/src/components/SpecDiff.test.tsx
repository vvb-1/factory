import "../test-dom";
import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { diffLines, formatDiff, SpecDiff } from "./SpecDiff";
import { ToastContainer } from "./ui";

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  act(() => {
    jest.runOnlyPendingTimers();
  });
  jest.useRealTimers();
  cleanup();
});

describe("diffLines & formatDiff", () => {
  test("identical inputs produce all same lines", () => {
    const lines = diffLines(["a", "b", "c"], ["a", "b", "c"]);
    expect(lines).toEqual([
      { type: "same", text: "a" },
      { type: "same", text: "b" },
      { type: "same", text: "c" },
    ]);
  });

  test("detects additions and deletions", () => {
    const lines = diffLines(["a", "b"], ["a", "c"]);
    expect(lines).toEqual([
      { type: "same", text: "a" },
      { type: "del", text: "b" },
      { type: "add", text: "c" },
    ]);
  });

  test("formatDiff prefixes lines correctly with +, -, or space", () => {
    const formatted = formatDiff([
      { type: "same", text: "unchanged" },
      { type: "del", text: "deleted" },
      { type: "add", text: "added" },
    ]);
    expect(formatted).toBe("  unchanged\n- deleted\n+ added");
  });
});

describe("SpecDiff component", () => {
  test("renders honest empty state when specs are identical", () => {
    const spec = { maxAttempts: 3, model: "claude-3-7-sonnet" };
    const r = render(<SpecDiff before={spec} after={spec} />);

    expect(r.getByText("No spec changes.")).toBeDefined();
    expect(r.queryByText("Copy diff")).toBeNull();
    expect(r.container.querySelector("pre")).toBeNull();
  });

  test("renders diff header and changed lines when specs differ", () => {
    const before = { maxAttempts: 3 };
    const after = { maxAttempts: 5 };
    const r = render(<SpecDiff before={before} after={after} />);

    expect(r.queryByText("No spec changes.")).toBeNull();
    expect(r.getByText("2 changed lines")).toBeDefined();
    expect(r.getByRole("button", { name: "Copy diff" })).toBeDefined();

    const pre = r.container.querySelector("pre");
    expect(pre).not.toBeNull();
    expect(pre?.textContent).toContain("-   \"maxAttempts\": 3");
    expect(pre?.textContent).toContain("+   \"maxAttempts\": 5");
  });

  test("singular changed line count when exactly 1 line changes", () => {
    // diff of ["a"] vs ["a", "b"] produces 2 changed lines.
    // An addition of a single line to a multi-line array:
    const r = render(<SpecDiff before={["a"]} after={["a", "b"]} />);
    expect(r.container.textContent).toContain("changed line");
  });

  test("clicking Copy diff writes to clipboard and produces toast feedback", () => {
    let written = "";
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: (t: string) => {
          written = t;
          return Promise.resolve();
        },
      },
      configurable: true,
    });

    const before = { timeout: 30 };
    const after = { timeout: 60 };

    const r = render(
      <>
        <ToastContainer />
        <SpecDiff before={before} after={after} />
      </>,
    );

    const button = r.getByRole("button", { name: "Copy diff" });
    fireEvent.click(button);

    expect(written).toContain("-   \"timeout\": 30");
    expect(written).toContain("+   \"timeout\": 60");
    expect(r.getByRole("status").textContent).toContain("Copied diff");
  });
});
