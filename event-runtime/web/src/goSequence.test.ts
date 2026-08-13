import { describe, expect, test } from "bun:test";
import { goSequence } from "./goSequence";

/** A stepper over the real nav suffixes, with a clock the test drives. */
function chord(targets = ["g", "o", "e", "p", "r", "t", "w"]) {
  let now = 1_000;
  const press = goSequence((k) => targets.includes(k), () => now);
  return { press, at: (t: number) => (now = t) };
}

describe("goSequence", () => {
  test("g g completes the chord inside the window — the Graph suffix is not swallowed", () => {
    const c = chord();
    expect(c.press("g")).toBe(false);
    c.at(1_500);
    expect(c.press("g")).toBe(true);
  });

  test("a single g still arms the prefix for every other suffix", () => {
    for (const suffix of ["o", "e", "p", "r", "t", "w"]) {
      const c = chord();
      expect(c.press("g")).toBe(false);
      expect(c.press(suffix)).toBe(true);
    }
  });

  test("a g after the window lapses re-arms rather than navigating", () => {
    const c = chord();
    c.press("g");
    c.at(2_000);
    expect(c.press("g")).toBe(false);
    c.at(2_200);
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
    c.at(2_000);
    expect(c.press("w")).toBe(false);
  });

  test("an unmapped key disarms the prefix", () => {
    const c = chord();
    c.press("g");
    expect(c.press("x")).toBe(false);
    expect(c.press("w")).toBe(false);
  });

  test("with no Graph target, the second g re-arms instead of matching", () => {
    const c = chord(["o"]);
    c.press("g");
    expect(c.press("g")).toBe(false);
    expect(c.press("o")).toBe(true);
  });
});
