/**
 * Decision helper and notification formatter for deep-link reveal operations (OPS-388).
 *
 * When an operator follows a deep link (#/runs/:id or #/events/:source/:id)
 * to a row that is hidden by the active status tab and/or active filters/chips,
 * the app adjusts view state to reveal the row and provides informative toast feedback.
 */

export interface RevealFeedbackInput {
  kind: "run" | "event" | "proposal";
  id: string;
  state?: string | null;
  tabChanged: boolean;
  filterCleared: boolean;
}

/**
 * Returns a human-readable feedback message describing what the reveal changed,
 * or null if nothing was changed (silent reveal).
 */
export function formatRevealNotification(
  input: RevealFeedbackInput,
): string | null {
  const { kind, id, state, tabChanged, filterCleared } = input;
  if (!tabChanged && !filterCleared) return null;

  const stateReason = state
    ? ` — ${kind} ${id} is ${state}`
    : ` to show ${kind} ${id}`;

  if (tabChanged && filterCleared) {
    return `Showing all states and cleared filter${stateReason}`;
  }

  if (tabChanged) {
    return `Showing all states${stateReason}`;
  }

  // filterCleared only
  return `Cleared the filter to show ${kind} ${id}`;
}

/**
 * Pure decision helper for filter clearing during a reveal latch (OPS-250, OPS-252).
 *
 * Given the filter snapshot at arm time, the current filter state, the empty/default
 * filter state, and whether the target row is currently visible:
 * - If visible: keeps all current filters and reports nothing cleared.
 * - If hidden: clears only those filter fields that match the arm-time snapshot
 *   (i.e. unchanged by the operator since arming) and differ from emptyValues.
 *   Any filter modified by the operator after arming is preserved.
 */
export function decideRevealFilters<T extends Record<string, unknown>>(
  snapshot: T,
  current: T,
  emptyValues: T,
  isVisible: boolean,
): {
  next: T;
  cleared: boolean;
  clearedFields: (keyof T)[];
} {
  if (isVisible) {
    return {
      next: current,
      cleared: false,
      clearedFields: [],
    };
  }

  const next = { ...current };
  const clearedFields: (keyof T)[] = [];

  for (const key of Object.keys(current) as (keyof T)[]) {
    if (current[key] === snapshot[key] && current[key] !== emptyValues[key]) {
      next[key] = emptyValues[key];
      clearedFields.push(key);
    }
  }

  return {
    next,
    cleared: clearedFields.length > 0,
    clearedFields,
  };
}
