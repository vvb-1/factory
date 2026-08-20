import { describe, expect, it } from "bun:test";
import { tokenizeJson } from "./highlight";

describe("tokenizeJson", () => {
  it("reconstructs exact text without character loss", () => {
    const raw = JSON.stringify(
      {
        schemaVersion: "factory.event/v1",
        eventId: "evt-123",
        count: 42,
        fraction: 3.14159,
        negative: -10,
        scientific: 1e5,
        enabled: true,
        disabled: false,
        nullable: null,
        emptyObj: {},
        emptyArr: [],
        nested: {
          "colon:inside:key": "value with : colons",
          escaped: 'quote "inside" string',
        },
      },
      null,
      2,
    );

    const tokens = tokenizeJson(raw);
    const joined = tokens.map((t) => t.text).join("");
    expect(joined).toBe(raw);
  });

  it("classifies object keys vs string values properly", () => {
    const input = '{\n  "agent": "factory-status-report@1"\n}';
    const tokens = tokenizeJson(input);

    const keyToken = tokens.find((t) => t.kind === "key");
    const stringToken = tokens.find((t) => t.kind === "string");

    expect(keyToken?.text).toBe('"agent"');
    expect(stringToken?.text).toBe('"factory-status-report@1"');
  });

  it("classifies primitive types correctly", () => {
    const input =
      '{\n  "n": 100,\n  "b": true,\n  "f": false,\n  "nil": null\n}';
    const tokens = tokenizeJson(input);

    expect(
      tokens.some((t) => t.kind === "number" && t.text === "100"),
    ).toBeTrue();
    expect(
      tokens.some((t) => t.kind === "boolean" && t.text === "true"),
    ).toBeTrue();
    expect(
      tokens.some((t) => t.kind === "boolean" && t.text === "false"),
    ).toBeTrue();
    expect(
      tokens.some((t) => t.kind === "null" && t.text === "null"),
    ).toBeTrue();
  });

  it("handles empty arrays and objects", () => {
    const input = '{"empty": [], "obj": {}}';
    const tokens = tokenizeJson(input);

    expect(tokens.map((t) => t.text).join("")).toBe(input);
    expect(tokens.filter((t) => t.kind === "punct").map((t) => t.text)).toEqual(
      ["{", ":", "[", "]", ",", ":", "{", "}", "}"],
    );
  });
});
