import { test, expect } from "bun:test";
import path from "node:path";

const CLI = path.join(import.meta.dir, "actions-cache.mjs");
const usage = JSON.stringify({
  total_active_caches_size_in_bytes: 45_000_000_000,
  total_active_caches_count: 9,
  repository_cache_usages: [
    {
      full_name: "watt-mind/example",
      active_caches_size_in_bytes: 45_000_000_000,
      active_caches_count: 9,
    },
  ],
});

function run(args = []) {
  return Bun.spawnSync({
    cmd: ["bun", CLI, ...args],
    env: { ...process.env, FACTORY_ACTIONS_CACHE_USAGE_JSON: usage },
    stdout: "pipe",
    stderr: "pipe",
  });
}

test("actions-cache exits non-zero and renders a warning at the configured threshold", () => {
  const result = run(["--included-gb", "70", "--warning-percent", "60"]);
  expect(result.exitCode).toBe(1);
  expect(result.stdout.toString()).toContain("64.3%");
  expect(result.stdout.toString()).toContain("WARNING");
});

test("actions-cache can output its report as JSON", () => {
  const result = run(["--included-gb", "100", "--json"]);
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout.toString())).toMatchObject({
    bytes: 45_000_000_000,
    warning: false,
  });
});
