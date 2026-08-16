import { expect, test } from "bun:test";
import { DEFAULT_PORT, resolvePort } from "./dispatch.mjs";

test("defaults to the standard event-runtime port", () => {
  expect(DEFAULT_PORT).toBe(7381);
  expect(resolvePort({})).toBe(7381);
});

test("FACTORY_EVENT_PORT overrides the default port", () => {
  expect(resolvePort({ FACTORY_EVENT_PORT: "8123" })).toBe(8123);
});
