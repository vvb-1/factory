import { test, expect } from "bun:test";
import { renderActionsCacheUsage, summarizeActionsCacheUsage } from "./actions-cache.mjs";

const usage = {
  total_active_caches_size_in_bytes: 45_000_000_000,
  total_active_caches_count: 9,
  repository_cache_usages: [
    { full_name: "watt-mind/small", active_caches_size_in_bytes: 5_000_000_000, active_caches_count: 2 },
    { full_name: "watt-mind/large", active_caches_size_in_bytes: 40_000_000_000, active_caches_count: 7 },
  ],
};

test("summarizeActionsCacheUsage sorts repositories and warns at the threshold", () => {
  const summary = summarizeActionsCacheUsage(usage, { includedGb: 70, warningPercent: 60 });
  expect(summary.percent).toBeCloseTo(64.2857, 3);
  expect(summary.warning).toBe(true);
  expect(summary.repositories.map((repo) => repo.name)).toEqual(["watt-mind/large", "watt-mind/small"]);
  expect(renderActionsCacheUsage(summary)).toContain("WARNING: Actions cache storage is at or above the 60% threshold.");
});

test("summarizeActionsCacheUsage falls back to repository totals", () => {
  const summary = summarizeActionsCacheUsage({ repository_cache_usages: usage.repository_cache_usages }, { includedGb: 100, warningPercent: 60 });
  expect(summary.bytes).toBe(45_000_000_000);
  expect(summary.count).toBe(9);
  expect(summary.warning).toBe(false);
});
