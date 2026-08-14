import "../test-dom";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { RunDetailBlocks } from "./RunDetailBlocks";
import { createRunDetailFixture } from "../test-render";
import type { RunDetail, RunState } from "../types";

afterEach(() => {
  cleanup();
});

const noop = () => {};

function renderBlocks(d: RunDetail, overrides?: Partial<Parameters<typeof RunDetailBlocks>[0]>) {
  return render(
    <RunDetailBlocks
      d={d}
      now={Date.now()}
      connected={true}
      origin={null}
      onJumpAgent={noop}
      onJumpEvent={noop}
      onCancel={noop}
      onRetry={noop}
      onForceRetry={noop}
      retryPending={false}
      verbError={null}
      {...overrides}
    />,
  );
}

function detailWith(state: RunState, input: unknown): RunDetail {
  return createRunDetailFixture({
    run: { state, spec: { input } } as RunDetail["run"],
  });
}

describe("RunDetailBlocks field tiering (WM-129)", () => {
  test("promotes flat spec.input keys to first-class glance rows", () => {
    const r = renderBlocks(detailWith("RUNNING", { repo: "factory", ticket: "WM-64" }));
    expect(r.getByText("input.repo")).toBeTruthy();
    expect(r.getByText("factory")).toBeTruthy();
    expect(r.getByText("input.ticket")).toBeTruthy();
    expect(r.getByText("WM-64")).toBeTruthy();
  });

  test("renders a single input row for non-object inputs and none for empty ones", () => {
    const scalar = renderBlocks(detailWith("RUNNING", "raw-string-input"));
    expect(scalar.getByText("input")).toBeTruthy();
    expect(scalar.getByText("raw-string-input")).toBeTruthy();
    cleanup();
    const empty = renderBlocks(detailWith("RUNNING", {}));
    expect(empty.queryByText("input")).toBeNull();
  });

  test("demotes ids, hashes, and paths into a collapsed internals disclosure", () => {
    const d = createRunDetailFixture({ workspace: "/tmp/workspaces/run_test_1001" });
    const r = renderBlocks(d);
    const details = Array.from(r.container.querySelectorAll("details"));
    const internals = details.find((el) => el.textContent?.includes("internals"));
    expect(internals).toBeTruthy();
    expect(internals!.open).toBe(false);
    // The demoted rows live inside that disclosure, not on the glance tier.
    // Scoped to the disclosure: labels like `workspace` also appear on the
    // attempt cards, so a document-wide query would match more than one.
    for (const key of ["idempotencyKey", "specHash", "inputHash", "workspace", "promptVersion", "policyVersion"]) {
      const labels = Array.from(internals!.querySelectorAll("span")).filter((s) => s.textContent === key);
      expect(labels.length).toBe(1);
    }
    // The RunSpec ground truth stays, collapsed.
    const spec = details.find((el) => el.textContent?.includes("immutable RunSpec"));
    expect(spec).toBeTruthy();
    expect(spec!.open).toBe(false);
  });

  test("shows the Deadlines clocks for an in-flight run and hides them for a terminal one", () => {
    const running = renderBlocks(createRunDetailFixture({ run: { state: "RUNNING" } as RunDetail["run"] }));
    expect(running.getByText("Deadlines")).toBeTruthy();
    expect(running.getByText("lease owner")).toBeTruthy();
    cleanup();
    const done = renderBlocks(
      createRunDetailFixture({
        run: { state: "COMPLETED" } as RunDetail["run"],
        attempts: [],
      }),
    );
    expect(done.queryByText("Deadlines")).toBeNull();
  });

  test("attempt cards carry started/finished timestamps", () => {
    const r = renderBlocks(createRunDetailFixture({}));
    // Once in the Deadlines clock, once on the attempt card — the card row is the one this test owns.
    expect(r.getAllByText(/started/).length).toBeGreaterThanOrEqual(2);
  });

  test("offers Cancel for a cancellable run and wires it to onCancel", () => {
    const onCancel = mock(noop);
    const r = renderBlocks(createRunDetailFixture({ run: { state: "RUNNING" } as RunDetail["run"] }), { onCancel });
    fireEvent.click(r.getByText("Cancel"));
    expect(onCancel).toHaveBeenCalled();
    cleanup();
    // VERIFYING has already exited its agent — not cancellable, same rule as the panel.
    const verifying = renderBlocks(createRunDetailFixture({ run: { state: "VERIFYING" } as RunDetail["run"] }));
    expect(verifying.queryByText("Cancel")).toBeNull();
  });
});
