/**
 * Pick one factory stage from a queue.mjs summary row.
 *
 * Priority mirrors config/schedule.yaml + README loop ordering. Keeps
 * recommendation logic testable without hitting Linear.
 */
import { STAGE_GATES } from "./queue-summary.mjs";

/** @typedef {{ repo: string, reportOnly?: boolean, answered: number, openPRs: number, slotsFree: number, startable: string[], triageState: number, todoNotReady: number, orphanedClaims: number, blocked: number, triageHeld: number, ready: number, readyHeld: number, inProgress: number }} QueueSummary */

/**
 * @param {QueueSummary} s
 * @param {{ orchestrated?: boolean, includeSweep?: boolean }} opts
 */
export function recommendNext(s, { orchestrated = false, includeSweep = false } = {}) {
  const alternates = [];
  const note = (cmd, args, reason, extra = {}) => ({ repo: s.repo, command: cmd, args, reason, alternates, ...extra });

  const loopIdle =
    !STAGE_GATES.merge(s) &&
    !STAGE_GATES.dispatch(s) &&
    !STAGE_GATES.triage(s) &&
    s.todoNotReady === 0;

  if (s.answered > 0) {
    return note("factory-triage", "5",
      `${s.answered} held ticket(s) have replies — triage releases holds and re-runs promote-or-hold`,
      { constraint: "holds with answers", stage: "triage" });
  }

  if (s.openPRs > 0) {
    if (STAGE_GATES.triage(s)) {
      alternates.push(note("factory-triage", "5",
        `${s.triageState} Triage ticket(s) — specification backlog`, { stage: "triage" }));
    }
    return note("factory-merge", "",
      `${s.openPRs} open PR(s) waiting on GitHub (merge gate open)`,
      { constraint: "merge backlog", stage: "merge" });
  }

  if (s.slotsFree > 0 && s.startable.length > 0) {
    if (s.reportOnly) {
      return note(null, "",
        `report_only — ${s.startable.length} startable ticket(s) but dispatch is disabled here (PC-15)`,
        { constraint: "report_only", stage: "none" });
    }
    const ids = s.startable.slice(0, 3).join(", ");
    if (orchestrated) {
      return note("tick", "",
        `${s.startable.length} startable, ${s.slotsFree} slot(s) free — would start ${ids}`,
        {
          constraint: "execution",
          stage: "dispatch",
          exec: `bun orchestrator/tick.mjs --repo ${s.repo} --apply`,
          slash: null,
        });
    }
    return note("factory-work", "3 at a time",
      `${s.startable.length} startable, ${s.slotsFree} slot(s) free — would start ${ids}`,
      { constraint: "execution", stage: "dispatch" });
  }

  if (s.ready > 0 && s.slotsFree === 0) {
    return note(null, "",
      `${s.ready} ready ticket(s) but no free slot (${s.inProgress} In Progress, cap full) — wait for a slot`,
      { constraint: "capacity", stage: "none" });
  }

  if (s.ready > 0 && s.slotsFree > 0) {
    return note(null, "",
      `${s.ready} ready but none startable — Owned Paths collide with in-flight work`,
      { constraint: "path collision", stage: "none" });
  }

  if (s.readyHeld > 0) {
    return note(null, "",
      `${s.readyHeld} ready ticket(s) held by blockers — dispatch waits for their dependencies`,
      { constraint: "blocked", stage: "none" });
  }

  if (s.triageState > 0) {
    return note("factory-triage", "5",
      `${s.triageState} ticket(s) in Triage — specification is the bottleneck`,
      { constraint: "specification", stage: "triage" });
  }

  if (s.todoNotReady > 0) {
    return note("factory-triage", "5",
      `${s.todoNotReady} Todo ticket(s) missing ai:agent-ready — triage or label-guard`,
      { constraint: "specification", stage: "triage" });
  }

  if (s.orphanedClaims > 0) {
    alternates.push({
      repo: s.repo,
      command: "reconcile",
      args: "",
      reason: `${s.orphanedClaims} In Progress claim(s) with no live worker — reconcile frees dispatch slots`,
      exec: `bun orchestrator/reconcile.mjs --repo ${s.repo} --apply`,
      stage: "reconcile",
    });
  }

  if (s.blocked > 0 || s.triageHeld > 0) {
    const n = s.blocked + s.triageHeld;
    alternates.push({
      repo: s.repo,
      command: "digest",
      args: "",
      reason: `${n} hold(s) waiting — read blocking questions`,
      exec: `bun orchestrator/digest.mjs --repo ${s.repo}`,
      stage: "digest",
    });
    alternates.push(note("factory-unblock", "10",
      `${n} hold(s) — re-examine for evidence that resolved without a reply`, { stage: "unblock" }));
  }

  if (includeSweep && loopIdle) {
    return note("factory-sweep", "20",
      "main loop idle — optional hygiene sweep for obsolete tickets",
      { constraint: "idle", stage: "sweep" });
  }

  if (alternates.length) {
    const primary = alternates.shift();
    primary.alternates = alternates;
    return primary;
  }

  return note(null, "", "idle — nothing the factory loop would run right now",
    { constraint: "idle", stage: "none" });
}
