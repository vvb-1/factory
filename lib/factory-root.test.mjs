import { test, expect } from "bun:test";
import { existsSync } from "node:fs";
import path from "node:path";
import { factoryRoot } from "./factory-root.mjs";

test("factoryRoot finds the checkout from lib/ location", () => {
  const root = factoryRoot();
  expect(existsSync(path.join(root, "tools/linear.mjs"))).toBe(true);
});
