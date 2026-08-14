/**
 * Decision helper and notification formatter for deep-link reveal operations (OPS-388).
 *
 * When an operator follows a deep link (#/runs/:id or #/events/:source/:id)
 * to a row that is hidden by the active status tab and/or active filters/chips,
 * the app adjusts view state to reveal the row and provides informative toast feedback.
 */

export interface RevealFeedbackInput {
  kind: "run" | "event";
  id: string;
  state?: string | null;
  tabChanged: boolean;
  filterCleared: boolean;
}

/**
 * Returns a human-readable feedback message describing what the reveal changed,
 * or null if nothing was changed (silent reveal).
 */
export function formatRevealNotification(input: RevealFeedbackInput): string | null {
  const { kind, id, state, tabChanged, filterCleared } = input;
  if (!tabChanged && !filterCleared) return null;

  const stateReason = state ? ` — ${kind} ${id} is ${state}` : ` to show ${kind} ${id}`;

  if (tabChanged && filterCleared) {
    return `Showing all states and cleared filter${stateReason}`;
  }

  if (tabChanged) {
    return `Showing all states${stateReason}`;
  }

  // filterCleared only
  return `Cleared the filter to show ${kind} ${id}`;
}
