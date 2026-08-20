import "./test-dom";
import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, render } from "@testing-library/react";
import { useState } from "react";
import { CONTEXT_TABS_ATTR, useTabKeys } from "./hooks";

const VIEW_TABS = ["queued", "running"] as const;

function StatusAndStrip() {
  const [tab, setTab] = useState<(typeof VIEW_TABS)[number]>("queued");
  useTabKeys(VIEW_TABS, tab, setTab);
  return (
    <>
      <div role="tablist" aria-label="Context" {...{ [CONTEXT_TABS_ATTR]: "" }}>
        <button type="button" role="tab" aria-selected={true}>
          All
        </button>
      </div>
      <div role="tablist" aria-label="View status">
        {VIEW_TABS.map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t}>
            {t}
          </button>
        ))}
      </div>
    </>
  );
}

afterEach(() => {
  cleanup();
});

describe("useTabKeys", () => {
  test("] scrolls the view status tab, not the context strip", () => {
    const scrolled: HTMLElement[] = [];
    const original = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) {
      scrolled.push(this);
    };

    try {
      const r = render(<StatusAndStrip />);
      scrolled.length = 0;

      act(() => {
        document.body.dispatchEvent(
          new KeyboardEvent("keydown", { key: "]", bubbles: true }),
        );
      });

      expect(scrolled.length).toBeGreaterThan(0);
      expect(
        scrolled.every((el) => !el.closest(`[${CONTEXT_TABS_ATTR}]`)),
      ).toBe(true);
      const viewTab = r.getByRole("tab", { name: "running" });
      expect(viewTab.getAttribute("aria-selected")).toBe("true");
      expect(scrolled).toContain(viewTab);
      expect(scrolled).not.toContain(r.getByRole("tab", { name: "All" }));
    } finally {
      HTMLElement.prototype.scrollIntoView = original;
    }
  });
});
