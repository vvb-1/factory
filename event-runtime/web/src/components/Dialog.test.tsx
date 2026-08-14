import "../test-dom";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { modal } from "../hooks";
import { Dialog } from "./ui";

function AutofocusChip() {
  const ref = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    ref.current?.setAttribute("autofocus", "");
  }, []);
  return (
    <button ref={ref} type="button" data-testid="chip">
      chip
    </button>
  );
}

function OpenDialog({
  onClose,
  children,
}: {
  onClose: () => void;
  children?: ReactNode;
}) {
  return (
    <Dialog title="Inject" onClose={onClose}>
      <textarea data-testid="envelope" />
      <AutofocusChip />
      {children}
    </Dialog>
  );
}

beforeEach(() => {
  modal.depth = 0;
});

afterEach(() => {
  modal.depth = 0;
  cleanup();
});

describe("Dialog", () => {
  test("opening focuses the stamped [autofocus] control once", () => {
    const r = render(<OpenDialog onClose={() => {}} />);
    expect(document.activeElement).toBe(r.getByTestId("chip"));
  });

  test("a parent re-render does not steal focus back to [autofocus]", () => {
    const r = render(<OpenDialog onClose={() => {}} />);
    const envelope = r.getByTestId("envelope");
    envelope.focus();
    expect(document.activeElement).toBe(envelope);

    r.rerender(<OpenDialog onClose={() => {}} />);
    expect(document.activeElement).toBe(envelope);
  });

  test("Escape calls the current onClose, not the first-render copy", () => {
    const closed: string[] = [];
    function Parent({ tag }: { tag: string }) {
      return <OpenDialog onClose={() => closed.push(tag)} />;
    }
    const r = render(<Parent tag="first" />);
    r.rerender(<Parent tag="current" />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(closed).toEqual(["current"]);
  });

  test("modal.depth increments once per open and decrements once on close", () => {
    expect(modal.depth).toBe(0);
    const r = render(<OpenDialog onClose={() => {}} />);
    expect(modal.depth).toBe(1);
    r.rerender(<OpenDialog onClose={() => {}} />);
    expect(modal.depth).toBe(1);
    r.unmount();
    expect(modal.depth).toBe(0);
  });

  test("a confirm button mounted later still receives React autoFocus", () => {
    function Row() {
      const [confirm, setConfirm] = useState(false);
      return (
        <OpenDialog onClose={() => {}}>
          <button type="button" data-testid="choose" onClick={() => setConfirm(true)}>
            choose
          </button>
          {confirm ? (
            <button type="button" data-testid="confirm" autoFocus>
              Confirm inject
            </button>
          ) : null}
        </OpenDialog>
      );
    }
    const r = render(<Row />);
    fireEvent.click(r.getByTestId("choose"));
    expect(document.activeElement).toBe(r.getByTestId("confirm"));
  });

  test("Tab from the last control wraps to the first inside the panel", () => {
    const r = render(<OpenDialog onClose={() => {}} />);
    const envelope = r.getByTestId("envelope");
    const chip = r.getByTestId("chip");
    chip.focus();
    fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement).toBe(envelope);
  });
});
