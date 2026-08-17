import { describe, expect, test } from "bun:test";
import { linkifyText } from "./linkify";

describe("linkifyText", () => {
  test("linkifies a plain URL", () => {
    expect(linkifyText("See https://example.com/runs/42.")).toEqual([
      { kind: "text", text: "See " },
      {
        kind: "link",
        text: "https://example.com/runs/42",
        href: "https://example.com/runs/42",
        title: "https://example.com/runs/42",
      },
      { kind: "text", text: "." },
    ]);
  });

  test("shortens GitHub pull request URLs and excludes closing delimiters", () => {
    const url = "https://github.com/watt-mind/factory/pull/486";
    expect(linkifyText(`<${url}>`)).toEqual([
      { kind: "text", text: "<" },
      {
        kind: "link",
        text: "watt-mind/factory#486",
        href: url,
        title: url,
      },
      { kind: "text", text: ">" },
    ]);
  });

  test("links Linear-style ticket ids", () => {
    expect(linkifyText("Fixes WM-546")).toEqual([
      { kind: "text", text: "Fixes " },
      {
        kind: "link",
        text: "WM-546",
        href: "https://linear.app/watt-mind/issue/WM-546",
        title: "WM-546",
      },
    ]);
  });

  test("leaves text without matches unchanged", () => {
    expect(linkifyText("Nothing to link here.")).toEqual([
      { kind: "text", text: "Nothing to link here." },
    ]);
  });
});
