import { describe, expect, test } from "bun:test";
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
  test("every NAV view chord derives from matrix and resolves to its expected route", () => {
    const dispatched: string[] = [];
    const routes: Record<string, () => void> = Object.fromEntries(
      NAV.map((n) => [
        n.go,
        () => {
          dispatched.push(n.key);
        },
      ]),
    );
    const seq = goSequence((key) => Object.hasOwn(routes, key));

    for (const item of NAV) {
      dispatched.length = 0;
      expect(seq.press("g")).toBe(false);
      expect(seq.armed()).toBe(true);
      const completed = seq.press(item.go);
      expect(completed).toBe(true);
      if (completed) {
        routes[item.go]();
      }
      expect(dispatched).toEqual([item.key]);
      expect(seq.armed()).toBe(false);
    }
  });

  test("navigation matrix maps each route key to a unique chord suffix", () => {
    const suffixes = new Set<string>();
    const keys = new Set<string>();

    for (const item of NAV) {
      expect(suffixes.has(item.go)).toBe(false);
      expect(keys.has(item.key)).toBe(false);
      suffixes.add(item.go);
      keys.add(item.key);
    }

    expect(suffixes.size).toBe(NAV.length);
    expect(keys.size).toBe(NAV.length);
  });

  test("navigation chords fail if a view suffix is omitted or hardcoded", () => {
    const legacyHardcoded = ["o", "e", "p", "r", "t", "w", "g"];
    const hardcodedRoutes = Object.fromEntries(
      legacyHardcoded.map((key) => [key, () => {}]),
    );
    const hardcodedChord = goSequence((k) => Object.hasOwn(hardcodedRoutes, k));

    const missingItems = NAV.filter((n) => !legacyHardcoded.includes(n.go));
    expect(missingItems.length).toBeGreaterThan(0);

    for (const missing of missingItems) {
      hardcodedChord.press("g");
      expect(hardcodedChord.press(missing.go)).toBe(false);
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
