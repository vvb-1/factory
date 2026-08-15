import { describe, expect, test } from "bun:test";
import { fieldErrorVisible } from "./injectForm";

describe("fieldErrorVisible (WM-78)", () => {
  test("hides errors until the field is touched or submit is attempted", () => {
    expect(fieldErrorVisible("repo", {}, false)).toBe(false);
    expect(fieldErrorVisible("repo", { repo: true }, false)).toBe(true);
    expect(fieldErrorVisible("repo", {}, true)).toBe(true);
    expect(fieldErrorVisible("repo", { other: true }, false)).toBe(false);
  });
});
