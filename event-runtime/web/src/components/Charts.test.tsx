import "../test-dom";
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { Band, Sparkline, StackedBars } from "./Charts";

afterEach(cleanup);

describe("Sparkline", () => {
  test("names empty, single-point, and linked series without inventing a flat line", () => {
    const empty = render(<Sparkline values={[]} label="No retries" />);
    expect(
      empty.getByRole("img", { name: "No retries" }).getAttribute("data-empty"),
    ).toBe("true");
    expect(empty.container.querySelector("polyline")).toBeNull();
    empty.unmount();

    const one = render(
      <Sparkline
        values={[3]}
        label="Retries"
        linkForPoint={() => ({
          href: "#/runs?population=retried",
          label: "3 retries",
        })}
      />,
    );
    expect(one.container.querySelectorAll("[data-point]")).toHaveLength(1);
    expect(
      one.getByRole("link", { name: "3 retries" }).getAttribute("href"),
    ).toContain("population=retried");
    expect(one.container.querySelector("polyline")).toBeNull();
  });
});

describe("StackedBars", () => {
  test("renders plain arrays, empty data, and accessible segment links", () => {
    const empty = render(<StackedBars bars={[]} label="No outcomes" />);
    expect(
      empty
        .getByRole("img", { name: "No outcomes" })
        .getAttribute("data-empty"),
    ).toBe("true");
    empty.unmount();

    const chart = render(
      <StackedBars
        label="Outcome mix"
        bars={[
          {
            key: "now",
            label: "Now",
            segments: [
              { key: "ok", label: "Completed", value: 2, hue: "var(--hue-ok)" },
              {
                key: "failed",
                label: "Failed",
                value: 1,
                hue: "var(--hue-err)",
                link: { href: "#/runs?state=FAILED", label: "1 failed run" },
              },
            ],
          },
        ]}
      />,
    );
    expect(chart.container.querySelectorAll("rect[data-segment]")).toHaveLength(
      2,
    );
    expect(chart.getByRole("link", { name: "1 failed run" })).toBeTruthy();
  });
});

describe("Band", () => {
  test("keeps an interior null as a real gap and handles empty/single-point data", () => {
    const empty = render(<Band values={[]} label="No latency" />);
    expect(
      empty.getByRole("img", { name: "No latency" }).getAttribute("data-empty"),
    ).toBe("true");
    empty.unmount();

    const single = render(
      <Band values={[{ p50: 10, p95: 20 }]} label="One latency sample" />,
    );
    expect(
      single.container.querySelectorAll("[data-band-segment]"),
    ).toHaveLength(1);
    expect(single.container.querySelectorAll("[data-point]")).toHaveLength(1);
    single.unmount();

    const gap = render(
      <Band
        values={[
          { p50: 10, p95: 20 },
          { p50: 12, p95: 24 },
          { p50: null, p95: null },
          { p50: 30, p95: 50 },
          { p50: 32, p95: 60 },
        ]}
        label="Execution p50 to p95"
      />,
    );
    expect(gap.container.querySelectorAll("[data-band-segment]")).toHaveLength(
      2,
    );
    expect(
      gap.container.querySelectorAll("[data-median-segment]"),
    ).toHaveLength(2);
    expect(gap.container.querySelectorAll("[data-point]")).toHaveLength(4);
  });
});
