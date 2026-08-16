import "./test-dom";
import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { createElement } from "react";
import { App } from "./App";
import { GO_CHORD_MS, goSequence } from "./goSequence";
import { NAV } from "./nav";

/** Every `g`-chord suffix registered in nav — single source for the matrix. */
const NAV_SUFFIXES: string[] = NAV.map((n) => n.go);

/** A stepper over the real nav suffixes, with a clock the test drives. */
function chord(targets = NAV_SUFFIXES) {
  let now = GO_CHORD_MS;
  const seq = goSequence((k) => targets.includes(k), () => now);
  return { press: seq.press, armed: seq.armed, at: (t: number) => (now = t) };
}

describe("goSequence", () => {
  test("App derives useGoSequences view chords from the navigation matrix", () => {
    const mutableNav = NAV as unknown as Array<{
      key: string;
      label: string;
      go: string;
    }>;
    const firstView = mutableNav[0]!;
    const originalSuffix = firstView.go;
    const sentinelSuffix = "z";
    const realFetch = globalThis.fetch;
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, refetchInterval: false } },
    });

    firstView.go = sentinelSuffix;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    window.location.href = "http://localhost/#/events";

    try {
      render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(App),
        ),
      );
      act(() => {
        fireEvent.keyDown(document.body, { key: "g" });
        fireEvent.keyDown(document.body, { key: sentinelSuffix });
      });
      expect(window.location.hash).toBe(`#/${firstView.key}`);
    } finally {
      cleanup();
      firstView.go = originalSuffix;
      globalThis.fetch = realFetch;
    }
  });

  test("g g completes the chord inside the window — the Graph suffix is not swallowed", () => {
    const c = chord();
    expect(c.press("g")).toBe(false);
    c.at(GO_CHORD_MS + Math.floor(GO_CHORD_MS / 2));
    expect(c.press("g")).toBe(true);
  });

  test("a single g still arms the prefix for every other suffix", () => {
    for (const suffix of NAV_SUFFIXES.filter((k) => k !== "g")) {
      const c = chord();
      expect(c.press("g")).toBe(false);
      expect(c.press(suffix)).toBe(true);
    }
  });

  test("a g after the window lapses re-arms rather than navigating", () => {
    const c = chord();
    c.press("g");
    c.at(GO_CHORD_MS + GO_CHORD_MS + 1);
    expect(c.press("g")).toBe(false);
    c.at(GO_CHORD_MS + GO_CHORD_MS + 1 + Math.floor(GO_CHORD_MS / 2));
    expect(c.press("g")).toBe(true);
  });

  test("a completed chord is spent — the third g re-arms instead of firing again", () => {
    const c = chord();
    c.press("g");
    expect(c.press("g")).toBe(true);
    expect(c.press("g")).toBe(false);
  });

  test("a lapsed suffix does not navigate", () => {
    const c = chord();
    c.press("g");
    c.at(GO_CHORD_MS + GO_CHORD_MS);
    expect(c.press("w")).toBe(false);
  });

  test("an unmapped key disarms the prefix", () => {
    const c = chord();
    c.press("g");
    expect(c.press("x")).toBe(false);
    expect(c.press("w")).toBe(false);
  });

  test("nothing is armed before the first key", () => {
    expect(chord().armed()).toBe(false);
  });

  test("a bare g reads as armed for the whole window and not past it", () => {
    const c = chord();
    c.press("g");
    expect(c.armed()).toBe(true);
    c.at(GO_CHORD_MS + GO_CHORD_MS - 1);
    expect(c.armed()).toBe(true);
    c.at(GO_CHORD_MS + GO_CHORD_MS);
    expect(c.armed()).toBe(false);
  });

  test("a resolved chord is no longer armed", () => {
    for (const suffix of ["g", "o", "w"]) {
      const c = chord();
      c.press("g");
      expect(c.press(suffix)).toBe(true);
      expect(c.armed()).toBe(false);
    }
  });

  test("a key that breaks the chord clears the armed state", () => {
    const c = chord();
    c.press("g");
    c.press("x");
    expect(c.armed()).toBe(false);
  });

  test("a lapsed g re-arms for a fresh window", () => {
    const c = chord();
    c.press("g");
    c.at(GO_CHORD_MS + GO_CHORD_MS);
    expect(c.armed()).toBe(false);
    c.press("g");
    expect(c.armed()).toBe(true);
  });

  test("with no Graph target, the second g re-arms instead of matching", () => {
    const c = chord(["o"]);
    c.press("g");
    expect(c.press("g")).toBe(false);
    expect(c.press("o")).toBe(true);
  });
});
