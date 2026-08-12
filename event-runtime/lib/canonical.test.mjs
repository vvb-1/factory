import { describe, expect, test } from "bun:test";
import { canonicalJson, hashBytes, hashJson } from "./canonical.mjs";

describe("canonicalJson", () => {
  test("sorts object keys recursively", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  test("preserves array order", () => {
    expect(canonicalJson([{ b: 1, a: 2 }, 3])).toBe('[{"a":2,"b":1},3]');
  });

  test("same value, different key order → same hash", () => {
    expect(hashJson({ x: 1, y: [true, null] })).toBe(hashJson({ y: [true, null], x: 1 }));
  });

  test("drops undefined object properties", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  test("rejects non-finite numbers and undefined array elements", () => {
    expect(() => canonicalJson({ a: Infinity })).toThrow(TypeError);
    expect(() => canonicalJson([undefined])).toThrow(TypeError);
  });
});

describe("hashes", () => {
  test("are prefixed sha256 over bytes", () => {
    expect(hashBytes("abc")).toBe("sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
