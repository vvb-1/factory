import "../test-dom";
import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { act, cleanup, render } from "@testing-library/react";
import { notify, ToastContainer } from "./ui";

function stackOf(r: ReturnType<typeof render>): HTMLElement {
  const parent = r.getByRole("status").parentElement;
  if (!parent) throw new Error("ToastContainer stack is missing");
  return parent;
}

function classes(el: HTMLElement): string[] {
  return el.className.split(/\s+/).filter(Boolean);
}

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  // activeToasts in ui.tsx is module-scoped with no exported reset. Drain the
  // 3s dismiss timeouts so leftover toasts cannot leak into the next test.
  act(() => {
    jest.runOnlyPendingTimers();
  });
  jest.useRealTimers();
  cleanup();
});

describe("ToastContainer", () => {
  test("mounts both live regions while empty so a later insert is announced", () => {
    const r = render(<ToastContainer />);
    const status = r.getByRole("status");
    const alert = r.getByRole("alert");
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(alert.getAttribute("aria-live")).toBe("assertive");
    expect(status.getAttribute("aria-atomic")).toBe("false");
    expect(alert.getAttribute("aria-atomic")).toBe("false");
    expect(classes(stackOf(r))).not.toContain("gap-2");
  });

  test("does not put gap-2 on the stack when only the polite region holds a toast", () => {
    const r = render(<ToastContainer />);
    act(() => {
      notify("polite only");
    });
    expect(classes(stackOf(r))).not.toContain("gap-2");
  });

  test("does not put gap-2 on the stack when only the assertive region holds a toast", () => {
    const r = render(<ToastContainer />);
    act(() => {
      notify("assertive only", "err");
    });
    expect(classes(stackOf(r))).not.toContain("gap-2");
  });

  test("puts gap-2 on the stack only when both regions hold a toast", () => {
    const r = render(<ToastContainer />);
    act(() => {
      notify("polite toast");
      notify("assertive toast", "err");
    });
    expect(classes(stackOf(r))).toContain("gap-2");
  });

  test("renders toasts as focusable buttons with message as accessible name and allows dismissal", () => {
    const r = render(<ToastContainer />);
    act(() => {
      notify("Operation succeeded", "ok");
    });
    const button = r.getByRole("button", { name: /Operation succeeded/i });
    expect(button).toBeTruthy();
    expect(button.getAttribute("type")).toBe("button");
    expect(button.getAttribute("title")).toBe("Dismiss");

    act(() => {
      button.click();
    });
    expect(r.queryByRole("button", { name: /Operation succeeded/i })).toBeNull();
  });
});
