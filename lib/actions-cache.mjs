const BYTES_PER_GB = 1_000_000_000;

export function formatGigabytes(bytes) {
  return `${(bytes / BYTES_PER_GB).toFixed(2)} GB`;
}

/** Turn GitHub's org cache-usage payload into a stable, display-ready snapshot. */
export function summarizeActionsCacheUsage(
  payload,
  { includedGb, warningPercent },
) {
  if (!Number.isFinite(includedGb) || includedGb <= 0) {
    throw new Error("includedGb must be a positive number");
  }
  if (
    !Number.isFinite(warningPercent) ||
    warningPercent <= 0 ||
    warningPercent > 100
  ) {
    throw new Error("warningPercent must be between 0 and 100");
  }

  const repositories = (payload.repository_cache_usages ?? [])
    .map((repo) => ({
      name: repo.full_name,
      count: repo.active_caches_count ?? 0,
      bytes: repo.active_caches_size_in_bytes ?? 0,
    }))
    .sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));
  const bytes =
    payload.total_active_caches_size_in_bytes ??
    repositories.reduce((total, repo) => total + repo.bytes, 0);
  const count =
    payload.total_active_caches_count ??
    repositories.reduce((total, repo) => total + repo.count, 0);
  const percent = (bytes / (includedGb * BYTES_PER_GB)) * 100;

  return {
    bytes,
    count,
    includedGb,
    warningPercent,
    percent,
    warning: percent >= warningPercent,
    repositories,
  };
}

export function renderActionsCacheUsage(summary) {
  const lines = [
    `GitHub Actions cache storage: ${formatGigabytes(summary.bytes)} / ${summary.includedGb.toFixed(2)} GB (${summary.percent.toFixed(1)}%)`,
    `Active entries: ${summary.count}; warning threshold: ${summary.warningPercent}%`,
    "",
    "Repository                         Entries       Storage",
  ];

  for (const repo of summary.repositories) {
    lines.push(
      `${repo.name.padEnd(34)} ${String(repo.count).padStart(7)}  ${formatGigabytes(repo.bytes).padStart(12)}`,
    );
  }

  if (summary.warning) {
    lines.push(
      "",
      `WARNING: Actions cache storage is at or above the ${summary.warningPercent}% threshold.`,
    );
  }
  return lines.join("\n");
}
