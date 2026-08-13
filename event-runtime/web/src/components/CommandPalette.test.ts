import { describe, expect, test } from "bun:test";
import { goSequenceHandler } from "./CommandPalette";

/** Minimal keydown stand-in: keyGuard only reads `target`, the rest are flags. */
function key(k: string, mods: Partial<KeyboardEvent> = {}) {
  return {
    key: k,
    target: null,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    repeat: false,
    preventDefault() {},
    ...mods,
  } as unknown as KeyboardEvent;
}

function harness(keys = ["g", "o", "w"]) {
  const hits: string[] = [];
  let now = 1_000;
  const map = Object.fromEntries(keys.map((k) => [k, () => hits.push(k)]));
  return { hits, map, handler: goSequenceHandler(map, () => now), at: (t: number) => (now = t) };
}

describe("goSequenceHandler", () => {
  test("g g navigates to the graph target inside the chord window", () => {
    const h = harness();
    h.handler(key("g"));
    h.at(1_500);
    h.handler(key("g"));
    expect(h.hits).toEqual(["g"]);
  });

  test("a single g still arms the prefix for the other suffixes", () => {
    const h = harness();
    h.handler(key("g"));
    h.handler(key("w"));
    h.handler(key("g"));
    h.handler(key("o"));
    expect(h.hits).toEqual(["w", "o"]);
  });

  test("a g after the window lapses re-arms instead of navigating", () => {
    const h = harness();
    h.handler(key("g"));
    h.at(2_000);
    h.handler(key("g"));
    expect(h.hits).toEqual([]);
    h.at(2_200);
    h.handler(key("g"));
    expect(h.hits).toEqual(["g"]);
  });

  test("g g does not fire twice — the third g re-arms", () => {
    const h = harness();
    h.handler(key("g"));
    h.handler(key("g"));
    h.handler(key("g"));
    expect(h.hits).toEqual(["g"]);
  });

  test("a lapsed suffix does not navigate", () => {
    const h = harness();
    h.handler(key("g"));
    h.at(2_000);
    h.handler(key("w"));
    expect(h.hits).toEqual([]);
  });

  test("an unmapped key disarms the prefix", () => {
    const h = harness();
    h.handler(key("g"));
    h.handler(key("x"));
    h.handler(key("w"));
    expect(h.hits).toEqual([]);
  });

  test("a held g auto-repeats without spending the prefix on Graph", () => {
    const h = harness();
    h.handler(key("g"));
    h.at(1_400);
    h.handler(key("g", { repeat: true }));
    h.handler(key("g", { repeat: true }));
    expect(h.hits).toEqual([]);
    h.at(1_500);
    h.handler(key("g"));
    expect(h.hits).toEqual(["g"]);
  });

  test("modified keys are left to the browser and the palette", () => {
    const h = harness();
    h.handler(key("g", { metaKey: true }));
    h.handler(key("g"));
    expect(h.hits).toEqual([]);
  });
});
