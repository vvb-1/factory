/**
 * The smallest adapter that satisfies the contract (docs/event-runtime-workers.md §2c):
 * an `execute()` entry point and a `SANDBOX_SUPPORT` verdict. It returns the
 * run's input as its result so extension tests can prove the module the
 * registry hands out is this one.
 */
export const SANDBOX_SUPPORT = "unsupported";

export async function execute({ spec } = {}) {
  return { ok: true, echoed: spec?.input ?? null };
}
