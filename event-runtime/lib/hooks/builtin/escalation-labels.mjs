/**
 * Built-in `approve.before` hook: refuse to auto-approve a dispatch whose
 * ticket carries an escalation or security label (WM-842).
 *
 * This is the check `dispatchSafe` in lib/auto-approval.mjs used to run
 * inline (`hasSecurityOrEscalation`), moved onto the hook seam unchanged: the
 * same labels are refused, with the same reason, at the same point of the
 * guard order — after the dispatch evidence hash is confirmed and before the
 * escalate-path intersection check. It reads only the recheck evidence the
 * chain approval already gathered (`ctx.evidence.ticket.labels`), so a
 * proposal without dispatch evidence (a merge, a ship, a triage apply) is
 * simply allowed, as it was before.
 */

export const id = "factory:escalation-labels";

/** The refusal reason, unchanged from the inline check. */
export const REASON = "escalated_or_security";

/**
 * @param {string[]} [labels]
 * @returns {boolean}
 */
export function hasSecurityOrEscalation(labels = []) {
  return labels.some(
    (label) =>
      label === "ai:escalated" ||
      label === "type:security" ||
      /security/i.test(label),
  );
}

/**
 * @param {{ evidence?: { ticket?: { labels?: string[] } } | null }} ctx
 * @returns {{ decision: "allow" } | { decision: "deny", reason: string }}
 */
export default function escalationLabels(ctx) {
  const labels = ctx?.evidence?.ticket?.labels ?? [];
  return hasSecurityOrEscalation(labels)
    ? { decision: "deny", reason: REASON }
    : { decision: "allow" };
}
