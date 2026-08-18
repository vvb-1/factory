/**
 * Disk space verification and thresholds (OPS-429).
 *
 * Prevents run execution and artifact ingestion when disk space on the runtime
 * host is critically low, failing closed before allocating workspaces or
 * corrupting stores.
 */
import { existsSync, statfsSync } from "node:fs";
import path from "node:path";

/** Minimum free bytes required before workspace materialization / artifact ingestion (500MB). */
export const DEFAULT_MIN_FREE_BYTES = 500 * 1024 * 1024;

/** Warning disk usage ratio threshold (85%). */
export const DEFAULT_WARN_USAGE_RATIO = 0.85;

/** Refusal disk usage ratio threshold (95%). */
export const DEFAULT_REFUSE_USAGE_RATIO = 0.95;

export class DiskSpaceError extends Error {
  constructor(
    message,
    { path, availableBytes, requiredBytes, totalBytes, usageRatio } = {},
  ) {
    super(message);
    this.name = "DiskSpaceError";
    this.path = path;
    this.availableBytes = availableBytes;
    this.requiredBytes = requiredBytes;
    this.totalBytes = totalBytes;
    this.usageRatio = usageRatio;
  }
}

/**
 * Resolve an existing directory path by traversing upwards if the given path does not exist.
 */
function resolveExistingPath(targetPath) {
  let current = path.resolve(targetPath);
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}

/**
 * Get disk space statistics for a given path.
 */
export function getDiskSpace(targetPath, { statfsFn = statfsSync } = {}) {
  const existingPath = resolveExistingPath(targetPath);
  const stats = statfsFn(existingPath);
  const bsize = Number(stats.bsize);
  const blocks = Number(stats.blocks);
  const bfree = Number(stats.bfree);
  const bavail = Number(stats.bavail);

  const totalBytes = blocks * bsize;
  const freeBytes = bfree * bsize;
  const availableBytes = bavail * bsize;
  const usedBytes = totalBytes - freeBytes;
  const usageRatio = totalBytes > 0 ? usedBytes / totalBytes : 0;

  return {
    totalBytes,
    freeBytes,
    availableBytes,
    usageRatio,
  };
}

/**
 * Check disk space against minimum free bytes and maximum usage ratio.
 * Throws DiskSpaceError if thresholds are violated.
 */
export function checkDiskSpace(
  targetPath,
  {
    minFreeBytes = DEFAULT_MIN_FREE_BYTES,
    maxUsageRatio = DEFAULT_REFUSE_USAGE_RATIO,
    statfsFn = statfsSync,
  } = {},
) {
  const space = getDiskSpace(targetPath, { statfsFn });
  if (space.availableBytes < minFreeBytes) {
    throw new DiskSpaceError(
      `insufficient free disk space at ${targetPath}: ${(space.availableBytes / (1024 * 1024)).toFixed(1)}MB available, minimum ${(minFreeBytes / (1024 * 1024)).toFixed(1)}MB required`,
      {
        path: targetPath,
        availableBytes: space.availableBytes,
        requiredBytes: minFreeBytes,
        totalBytes: space.totalBytes,
        usageRatio: space.usageRatio,
      },
    );
  }

  if (space.usageRatio > maxUsageRatio) {
    throw new DiskSpaceError(
      `disk space usage at ${targetPath} exceeds threshold: ${(space.usageRatio * 100).toFixed(1)}% used, maximum ${(maxUsageRatio * 100).toFixed(1)}% allowed`,
      {
        path: targetPath,
        availableBytes: space.availableBytes,
        requiredBytes: minFreeBytes,
        totalBytes: space.totalBytes,
        usageRatio: space.usageRatio,
      },
    );
  }

  return { ...space, ok: true };
}

/**
 * Assert disk space is sufficient for workspace materialization.
 */
export function assertDiskSpaceForWorkspace(workspaceRoot, options = {}) {
  return checkDiskSpace(workspaceRoot, options);
}

/**
 * Assert disk space is sufficient for artifact ingestion.
 */
export function assertDiskSpaceForArtifacts(artifactStore, options = {}) {
  return checkDiskSpace(artifactStore, options);
}
