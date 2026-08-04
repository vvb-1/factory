#!/usr/bin/env bun
/**
 * Where is the loop right now?
 *
 *   bun orchestrator/queue.mjs              # every configured repo
 *   bun orchestrator/queue.mjs --repo bj29
 *
 * Read-only. This is the `dry_command` for all three agent stages, so "what
 * would this job do" never means "spawn an agent and find out" — it means look
 * at the queue the job would draw from.
 *
 * It also answers the question that actually governs throughput: is the factory
 * about to idle? A deep Triage pile with an empty agent-ready queue means the
 * constraint is specification, not execution, and dispatching harder won't help.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { gql } from "./reaper.mjs";
import { ROOT } from "../lib/schedule.mjs";
import { parseOwnedPaths, effectiveOwnedPaths, pathsCollide } from "./owned-paths.mjs";
import { AI_BLOCKED, answeredHeldTickets } from "./reply-detection.mjs";
import { budgetExhausted } from "../lib/spend.mjs";
import { liveWorkerLeases } from "../lib/worker-leases.mjs";

const argv = process.argv.slice(2);
const val = (f) => { const i = argv.indexOf(f); return i === -1 ? null : argv[i + 1]; };
const only = (val("--repo") || "").split(",").map((s) => s.trim()).filter(Boolean);

// --gate <stage> turns this into a cheap predicate: exit 0 when that stage has
// work, 1 when it doesn't. That is what makes the loop continuous without being
// expensive — polling costs one Linear query, spawning an agent costs budget, so
// the supervisor checks often and acts only when there is something to do.
const GATE = val("--gate");
const JSON_OUT = argv.includes("--json");

const cfg = Bun.YAML.parse(readFileSync(path.join(ROOT, "config/repos.yaml"), "utf8"));
const policy = Bun.YAML.parse(readFileSync(path.join(ROOT, "config/policy.yaml"), "utf8"));
const defaultCap = policy?.concurrency?.max_in_flight_per_repo ?? 3;
const repos = (cfg.repos ?? []).filter((r) => !only.length || only.includes(r.name));

if (!repos.length) {
  console.error(only ? `no repo named "${only}" in config/repos.yaml` : "no repos configured");
  process.exit(2);
}

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

const QUERY = `
  query($team: String!, $project: String!) {
    issues(first: 250, filter: {
      team: { key: { eq: $team } },
      project: { name: { eq: $project } },
      state: { type: { nin: ["completed", "canceled"] } }
    }) {
      nodes {
        identifier title description priority url
        attachments(first: 20) { nodes { url } }
        state { name type }
        assignee { name }
        labels(first: 20) { nodes { name } }
      }
    }
  }`;

// Finished work, for the done/total readout. Kept out of QUERY on purpose: the
// active-issue query feeds gates and dispatch decisions, and mixing hundreds of
// Done tickets into `nodes` would push live work past the 250-issue page long
// before the project gets big enough to notice any other way.
const CLOSED_QUERY = `
  query($team: String!, $project: String!) {
    issues(first: 250, filter: {
      team: { key: { eq: $team } },
      project: { name: { eq: $project } },
      state: { type: { in: ["completed", "canceled"] } }
    }) {
      nodes { state { type } }
    }
  }`;

/**
 * Open PRs that a merge run could actually act on: not drafts, and not already
 * escalated to a human. Returns [] rather than throwing when `gh` is missing or
 * unauthenticated — a gate that hard-fails takes the whole supervisor loop down
 * with it, and being unable to see GitHub is not the same as having no work.
 */
async function openPRSummary(nameWithOwner) {
  // Include closed PRs in the association index too: a Linear ticket can lag
  // behind a merged PR, and the monitor should still link the evidence that
  // explains its review state. The displayed PR counts below remain OPEN-only.
  const p = Bun.spawnSync(["gh", "pr", "list", "--repo", nameWithOwner, "--state", "all", "--limit", "250",
    "--json", "number,url,body,isDraft,labels,title,state"]);
  if (p.exitCode !== 0) return { all: 0, drafts: 0, escalated: 0, allPRs: [], mergeCandidates: [] };
  try {
    const prs = JSON.parse(p.stdout.toString());
    const open = prs.filter((pr) => pr.state === "OPEN");
    return {
      all: open.length,
      drafts: open.filter((pr) => pr.isDraft).length,
      escalated: open.filter((pr) => (pr.labels ?? []).some((l) => l.name === "escalated")).length,
      allPRs: prs,
      mergeCandidates: open.filter((pr) => !pr.isDraft && !(pr.labels ?? []).some((l) => l.name === "escalated")),
    };
  } catch { return { all: 0, drafts: 0, escalated: 0, allPRs: [], mergeCandidates: [] }; }
}

/** Open PR associated with an issue through Linear's PR attachment or `Fixes ID`. */
function issuePR(issue, repo, prs) {
  const attachmentNumbers = new Set((issue.attachments?.nodes ?? []).flatMap((a) => {
    const m = new RegExp(`github\\.com/${repo.github.replace("/", "\\/")}/pull/(\\d+)`, "i").exec(a.url ?? "");
    return m ? [Number(m[1])] : [];
  }));
  const id = String(issue.identifier).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return prs.find((pr) => attachmentNumbers.has(pr.number) || new RegExp(`\\b${id}\\b`, "i").test(`${pr.title ?? ""}\n${pr.body ?? ""}`));
}

const summary = [];

for (const repo of repos) {
  if (!GATE && !JSON_OUT) console.log(c.bold(`\n${repo.name}`) + c.dim(`  ${repo.team} / ${repo.project}  ->  ${repo.base}`));

  const nodes = (await gql(QUERY, { team: repo.team, project: repo.project }))?.issues?.nodes ?? [];
  const closed = (await gql(CLOSED_QUERY, { team: repo.team, project: repo.project }))?.issues?.nodes ?? [];
  const done = closed.filter((i) => i.state?.type === "completed").length;
  const total = nodes.length + closed.length;
  // Either page hitting its 250 cap means these are floors, not counts.
  const countCapped = nodes.length === 250 || closed.length === 250;
  const labels = (i) => (i.labels?.nodes ?? []).map((l) => l.name);
  const state = (i) => i.state?.name ?? "?";

  // `ai:blocked` in Triage means a previous tick already decided this one needs
  // a human. Counting it as triage work is how the stage ends up re-deriving
  // the same hold every 5 minutes — the same shape as the merge stage
  // re-reviewing escalated PRs. It reappears the moment the label comes off —
  // or, below, the moment a reply lands after the label was applied.
  const triage = nodes.filter((i) => state(i) === "Triage" && !labels(i).includes(AI_BLOCKED));
  const triageHeld = nodes.filter((i) => state(i) === "Triage" && labels(i).includes(AI_BLOCKED));
  const ready = nodes.filter((i) => state(i) === "Todo" && labels(i).includes("ai:agent-ready") && !i.assignee);
  const notReady = nodes.filter((i) => state(i) === "Todo" && !labels(i).includes("ai:agent-ready"));
  const inProgress = nodes.filter((i) => state(i) === "In Progress");
  const inReview = nodes.filter((i) => state(i) === "In Review");
  const blocked = nodes.filter((i) => state(i) === "Blocked");

  // Held tickets someone has replied to since the hold. These re-enter the
  // triage stage's queue: the agent reads the answer, removes ai:blocked, and
  // re-runs promote-or-hold. The second query only fires when the cheap query
  // shows a held ticket at all.
  const heldAny = nodes.filter((i) => ["Triage", "Blocked"].includes(state(i)) && labels(i).includes(AI_BLOCKED));
  const answeredIds = heldAny.length ? await answeredHeldTickets(repo) : new Set();
  const answered = heldAny.filter((i) => answeredIds.has(i.identifier));

  // GitHub is the source of truth for what is waiting to merge, not Linear.
  // Gating the merge stage on `In Review` tickets meant a finished PR whose
  // ticket was never moved out of `In Progress` was invisible to it forever:
  // it held a dispatch slot AND never got reviewed. Two of bj29's three slots
  // sat that way for 13 hours with green-ish PRs open.
  //
  // `escalated` is the escape hatch that keeps this from becoming an infinite
  // poll: a PR the merge stage handed back to a human stays open by design, and
  // without the label every tick would re-review it and re-escalate. The merge
  // command applies the label when it escalates.
  const prs = repo.github ? await openPRSummary(repo.github) : { all: 0, drafts: 0, escalated: 0, allPRs: [], mergeCandidates: [] };
  const openPRs = prs.mergeCandidates;

  const quiet = GATE || JSON_OUT;
  const line = (label, n, color = (s) => s) => {
    if (!quiet) console.log(`  ${label.padEnd(22)} ${color(String(n).padStart(3))}`);
  };

  line("Triage (unspecified)", triage.length, triage.length > 20 ? c.yellow : (s) => s);
  if (triageHeld.length) line("Triage, held for you", triageHeld.length, c.red);
  if (answered.length) line("Held, reply received", answered.length, c.green);
  line("Todo, not ready", notReady.length);
  line("READY to dispatch", ready.length, ready.length ? c.green : c.red);
  line("In Progress", inProgress.length);
  line("In Review", inReview.length, inReview.length ? c.cyan : (s) => s);
  line("Blocked", blocked.length, blocked.length ? c.red : (s) => s);
  line("Done / project total", `${done}/${total}${countCapped ? "+" : ""}`, c.dim);

  // What dispatch would actually pick up, honouring Owned Paths against what is
  // already running. Sorted the way §7 sorts: priority asc, then created asc.
  //
  // report_only repos have no worktree tooling — dispatch must never target
  // them (see config/repos.yaml). Forcing slotsFree to 0 here is what keeps
  // the dispatch gate closed for them; without it the gate reports "work
  // available" from Linear state alone, run.mjs spawns tick.mjs, and tick.mjs
  // immediately exits 2 because the repo can't be dispatched — a FAIL every
  // tick for a repo that was never eligible to begin with.
  // Linear claims are an ownership/path fence even after their worker has
  // disappeared. Capacity, however, belongs to an actually live worker lease;
  // otherwise a dead process can consume the whole repo cap until a reaper
  // eventually notices it.
  const workers = liveWorkerLeases(repo.name);
  const workerIds = new Set(workers.map((w) => w.ticket));
  const orphanedClaims = inProgress.filter((i) => !workerIds.has(i.identifier));
  const inFlightPaths = inProgress.flatMap((i) => effectiveOwnedPaths(i.description ?? ""));
  const sorted = [...ready].sort((a, b) => (a.priority || 99) - (b.priority || 99));
  const slotsFree = repo.report_only ? 0 : Math.max(0, (repo.max_in_flight ?? defaultCap) - workers.length);
  const free = [];
  const busyPaths = [...inFlightPaths];
  for (const t of sorted) {
    if (free.length >= slotsFree) break;
    // Unparseable Owned Paths => treated as owning everything (see
    // effectiveOwnedPaths): still dispatchable, just serialized alone rather
    // than skipped forever.
    const own = effectiveOwnedPaths(t.description ?? "");
    if (pathsCollide(own, busyPaths)) continue;      // would collide with running work
    free.push(t);
    busyPaths.push(...own);                          // later tickets must clear this one too
  }

  summary.push({
    repo: repo.name,
    // The monitor uses this to open the selected repo's pull-request page
    // without duplicating the repo registry or guessing an owner from a path.
    github: repo.github,
    // Team key, so the monitor can scope actions like the reaper without
    // re-reading config/repos.yaml itself.
    team: repo.team,
    done,
    total,
    countCapped,
    triage: triage.length + notReady.length,
    // Triage-state only. The stage processes Triage tickets; gating on the
    // combined count kept the gate open for Todo-without-agent-ready tickets
    // the stage never touches, spawning a no-op agent every tick.
    triageState: triage.length,
    triageHeld: triageHeld.length,
    todoNotReady: notReady.length,
    // Held tickets with a reply newer than their ai:blocked application — the
    // triage stage re-examines these, so they open the triage gate too.
    answered: answered.length,
    ready: ready.length,
    inProgress: inProgress.length,
    workers: workers.length,
    liveWorkerIds: workers.map((w) => w.ticket),
    orphanedClaims: orphanedClaims.length,
    inReview: inReview.length,
    openPRs: openPRs.length,
    allOpenPRs: prs.all,
    draftPRs: prs.drafts,
    escalatedPRs: prs.escalated,
    blocked: blocked.length,
    slotsFree,
    startable: free.map((t) => t.identifier),
    // Keep the full ticket identity alongside the compact id list: the TUI
    // renders this as the manual-dispatch picker. `free` is deliberately the
    // same collision- and capacity-aware selection the automatic dispatcher
    // would make at this instant.
    startableTickets: free.map((t) => ({ identifier: t.identifier, title: t.title, url: t.url })),
    // Identifier + title + url — enough for a monitor (orchestrator/watch.jsx)
    // to render a ticket list and deep-link into Linear without re-querying
    // Linear itself.
    inProgressTickets: inProgress.map((t) => {
      const pr = issuePR(t, repo, prs.allPRs);
      return { identifier: t.identifier, title: t.title, url: t.url, prNumber: pr?.number, prUrl: pr?.url };
    }),
    inReviewTickets: inReview.map((t) => {
      const pr = issuePR(t, repo, prs.allPRs);
      return { identifier: t.identifier, title: t.title, url: t.url, prNumber: pr?.number, prUrl: pr?.url };
    }),
    blockedTickets: blocked.map((t) => ({ identifier: t.identifier, title: t.title, url: t.url })),
    answeredTickets: answered.map((t) => ({ identifier: t.identifier, title: t.title, url: t.url })),
  });

  if (quiet) continue;

  if (free.length) {
    console.log(c.dim(`\n  dispatch would start (cap ${repo.max_in_flight}, ${inProgress.length} running, ${slotsFree} slot(s) free):`));
    for (const t of free) console.log(`    ${c.green(t.identifier.padEnd(10))} ${t.title.slice(0, 60)}`);
  } else if (repo.report_only && ready.length) {
    console.log(c.dim(`\n  report_only — dispatch is disabled here by design (${ready.length} ready ticket(s) would otherwise start)`));
  } else if (ready.length && slotsFree === 0) {
    // Distinguish "no room" from "nothing fits". Reporting the Owned Paths
    // reason when the cap is simply full sends you reading glob sets for a
    // problem that is a full slot table.
    console.log(c.dim(`\n  no free worker slot — ${workers.length}/${repo.max_in_flight ?? defaultCap} live, ${ready.length} ready and waiting`));
    for (const t of inProgress.filter((i) => workerIds.has(i.identifier))) console.log(c.dim(`    working: ${t.identifier.padEnd(10)} ${t.title.slice(0, 55)}`));
  } else if (ready.length) {
    console.log(c.dim(`\n  nothing startable — all ready tickets collide with running or with each other's unparseable Owned Paths`));
  } else {
    console.log(c.dim(`\n  queue empty — the constraint is specification, not dispatch.`));
    console.log(c.dim(`  ${triage.length} ticket(s) in Triage. Run the triage stage.`));
  }

  if (inReview.length) {
    console.log(c.dim(`\n  awaiting review/merge:`));
    for (const t of inReview) console.log(`    ${c.cyan(t.identifier.padEnd(10))} ${t.title.slice(0, 60)}`);
  }
  if (openPRs.length) {
    console.log(c.dim(`\n  open PRs the merge stage would look at:`));
    for (const pr of openPRs) console.log(`    ${c.cyan(("#" + pr.number).padEnd(10))} ${pr.title.slice(0, 60)}`);
  }
  if (blocked.length) {
    console.log(c.red(`\n  BLOCKED — needs a human:`));
    for (const t of blocked) {
      const tag = answeredIds.has(t.identifier) ? c.green("  <- reply received, triage will re-examine") : "";
      console.log(`    ${t.identifier.padEnd(10)} ${t.title.slice(0, 60)}${tag}`);
    }
  }
}

if (JSON_OUT) {
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

if (GATE) {
  // The day budget binds EVERY stage that spawns an agent, not just dispatch.
  // Gating it in tick.mjs alone inverted the intent: over budget, the stage
  // that makes progress stopped while triage and merge kept spawning opus
  // sessions on their timers.
  const spent = budgetExhausted(policy);
  if (spent) {
    console.log(`${spent} — no ${GATE} this tick. Running work finishes; nothing new starts.`);
    process.exit(1);
  }

  // Exit 0 = there is work for this stage, so the supervisor should run it.
  // Exit 1 = idle, skip. Anything else is a real error and stops the loop.
  const has = {
    // Only spawn a triage agent when a Triage-STATE ticket is waiting — the
    // stage never touches Todo tickets, ready or not. A held ticket whose
    // question got answered is triage work again: the stage reads the reply
    // and re-runs promote-or-hold.
    triage: (s) => s.triageState > 0 || s.answered > 0,
    // Don't dispatch with no free slot or nothing startable — an agent that
    // wakes to find the cap full has burned a run to learn nothing.
    dispatch: (s) => s.slotsFree > 0 && s.startable.length > 0,
    // A PR waiting on GitHub is the work, whatever its ticket says — and
    // `openPRs` already excludes drafts and anything labelled `escalated`.
    //
    // This deliberately does NOT also fire on `In Review` tickets. It used to,
    // and that silently defeated the escalated-label escape hatch: an escalated
    // PR keeps its ticket In Review by design, so the gate stayed open and the
    // merge stage re-reviewed the same two PRs every 10 minutes — seven ticks,
    // ~$1.37 each, producing no new information and no way to stop short of
    // closing the PR. An In Review ticket with no actionable PR is drift for
    // the reconciler to explain, not merge work.
    merge: (s) => s.openPRs > 0,
  }[GATE];

  if (!has) {
    console.error(`unknown gate "${GATE}" (known: triage, dispatch, merge)`);
    process.exit(2);
  }

  const hits = summary.filter(has);
  if (hits.length) {
    console.log(hits.map((s) => `${s.repo}: ${GATE} work available`).join("; "));
    process.exit(0);
  }
  console.log(`no ${GATE} work in ${summary.map((s) => s.repo).join(", ")}`);
  process.exit(1);
}

console.log();
