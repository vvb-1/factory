#!/usr/bin/env bun
/**
 * Reconcile Linear ticket state with what GitHub actually shows.
 *
 *   bun orchestrator/reconcile.mjs --repo bj29            # dry — what it would move
 *   bun orchestrator/reconcile.mjs --repo bj29 --apply
 *   bun orchestrator/reconcile.mjs --repo bj29 --gate     # 0 = drift exists, 1 = clean
 *
 * WHY THIS EXISTS. A ticket in `In Progress` consumes a dispatch slot, and the
 * slot is meant to be freed the moment the agent opens its PR and moves the
 * ticket to `In Review` — at that point no agent is running and the work is
 * waiting on review, not on capacity. When that last step is missed (a crashed
 * run, a hand-opened PR, an agent that pushed and stopped), the ticket keeps
 * the slot forever and nothing notices, because a stuck ticket looks exactly
 * like a working one.
 *
 * Observed on bj29: CLNT-415 and CLNT-387 sat `In Progress` for 13 hours with
 * open PRs, holding two of three slots. Throughput was one agent out of three
 * and no stage reported an error — dispatch had no room, and the merge stage
 * could not see the PRs (OPS-44).
 *
 * The reaper does not cover this. Its question is "has this claim gone silent",
 * and these claims are not silent — they are finished. The evidence here is
 * positive rather than temporal: an open PR attached to the ticket means the
 * implementation phase is over, whatever the ticket says.
 *
 * SAFETY. This moves an active ticket to `In Review` only when its own PR is
 * open, and to `Done` only when its own PR is merged. It never acts on a
 * merely closed PR. A merged PR has already passed the merge stage's gate; this
 * is the recovery path for the last Linear write being missed after that gate.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { gql, lastActivity } from "./reaper.mjs";
import { ROOT } from "../lib/schedule.mjs";

const argv = process.argv.slice(2);
const val = (f) => { const i = argv.indexOf(f); return i === -1 ? null : argv[i + 1]; };
const APPLY = argv.includes("--apply");
const GATE = argv.includes("--gate");

const cfg = Bun.YAML.parse(readFileSync(path.join(ROOT, "config/repos.yaml"), "utf8"));
const names = (val("--repo") || "").split(",").map((s) => s.trim()).filter(Boolean);
const repos = (cfg.repos ?? []).filter((r) => names.includes(r.name));
if (!repos.length) { console.error(`--repo required; known: ${(cfg.repos ?? []).map((r) => r.name).join(", ")}`); process.exit(2); }

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`, bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`, red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`, cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

// An open PR is NOT on its own proof that the agent is done. It opens the PR,
// then waits on CI, runs its UX critique round, posts verification output, and
// finally moves the ticket itself. Freeing the slot underneath a session that
// is still working over-subscribes the cap — the exact failure the cap exists
// to prevent. So reconcile only what has also gone quiet, on the same
// heartbeat signal the reaper uses (linear.md: heartbeat every 20 minutes).
const QUIET_MIN = Number(val("--quiet-minutes") ?? 25);

const Q = `query($t:String!,$p:String!){ issues(first:250, filter:{
    team:{key:{eq:$t}}, project:{name:{eq:$p}}, state:{type:{nin:["completed","canceled"]}} }){
  nodes{ id identifier title startedAt updatedAt labels(first:20){nodes{id name}}
         state{ name }
         comments(last:1){ nodes{ createdAt } }
         attachments(first:20){ nodes{ url } } } } }`;

/** PR numbers attached to a ticket, for this repo only. */
function prNumbers(issue, nameWithOwner) {
  const re = new RegExp(`github\\.com/${nameWithOwner.replace("/", "\\/")}/pull/(\\d+)`, "i");
  const out = new Set();
  for (const a of issue.attachments?.nodes ?? []) {
    const m = re.exec(a.url ?? "");
    if (m) out.add(Number(m[1]));
  }
  return [...out];
}

function prState(nameWithOwner, number) {
  const p = Bun.spawnSync(["gh", "pr", "view", String(number), "--repo", nameWithOwner,
    "--json", "state,isDraft"]);
  if (p.exitCode !== 0) return null;
  try { return JSON.parse(p.stdout.toString()); } catch { return null; }
}

/** Remove only factory lifecycle markers; preserve all project labels. */
function settledLabelIds(issue) {
  return (issue.labels?.nodes ?? [])
    .filter((l) => !["ai:in-progress", "ai:needs-review", "ai:agent-ready"].includes(l.name) && !l.name.startsWith("agent:"))
    .map((l) => l.id);
}

let drift = 0;

for (const repo of repos) {
  if (!GATE) console.log(c.bold(`\n${repo.name}`) + c.dim(`  ${repo.team} / ${repo.project}`));
  if (!repo.github) { if (!GATE) console.log(c.dim("  no github: in repos.yaml — skipping")); continue; }

  const nodes = (await gql(Q, { t: repo.team, p: repo.project }))?.issues?.nodes ?? [];
  const states = (await gql(`query($t:String!){ team(id:$t){ states(first:50){ nodes{ id name type } } } }`, { t: repo.team }))?.team?.states?.nodes ?? [];
  const inReviewId = states.find((s) => s.name.toLowerCase() === "in review")?.id;
  const doneId = states.find((s) => s.type === "completed")?.id;
  const allLabels = (await gql(`query{ issueLabels(first:250){ nodes{ id name } } }`))?.issueLabels?.nodes ?? [];
  const labelId = (n) => allLabels.find((l) => l.name === n)?.id;

  for (const issue of nodes) {
    const prs = prNumbers(issue, repo.github);
    if (!prs.length) continue;

    const prStates = prs.map((n) => ({ number: n, state: prState(repo.github, n)?.state }));
    const open = prStates.filter((pr) => pr.state === "OPEN").map((pr) => pr.number);
    if (!open.length) {
      const merged = prStates.filter((pr) => pr.state === "MERGED").map((pr) => pr.number);
      if (!merged.length) {
        if (!GATE) console.log(c.dim(`  ${issue.identifier} — PR ${prs.map((n) => "#" + n).join(", ")} not open; leaving to the merge stage`));
        continue;
      }

      drift++;
      if (GATE) continue;
      console.log(`  ${c.yellow(issue.identifier)} has merged PR ${merged.map((n) => "#" + n).join(", ")} but is still ${issue.state?.name ?? "active"} — ${APPLY ? "moving to Done" : "would move to Done"}`);
      console.log(c.dim(`    ${issue.title.slice(0, 70)}`));
      if (!APPLY) continue;
      if (!doneId) { console.log(c.red(`    ! no completed state on team ${repo.team}, skipping`)); continue; }

      await gql(`mutation($id:String!,$in:IssueUpdateInput!){ issueUpdate(id:$id,input:$in){ success } }`,
        { id: issue.id, in: { stateId: doneId, labelIds: settledLabelIds(issue) } });
      await gql(`mutation($in:CommentCreateInput!){ commentCreate(input:$in){ success } }`,
        { in: { issueId: issue.id, body:
          `**State reconciled: \`${issue.state?.name ?? "active"}\` → \`Done\`.**\n\n` +
          `PR ${merged.map((n) => `#${n}`).join(", ")} is merged, but the ticket's final Linear update was missed. ` +
          `Removed the factory lifecycle labels; all project labels were preserved.` } });
      continue;
    }

    // A ticket already in review is correctly represented by an open PR. Only
    // In Progress tickets consume dispatch capacity and need this transition.
    if (issue.state?.name !== "In Progress") continue;

    const quietFor = Math.round((Date.now() - (lastActivity(issue)?.getTime() ?? Date.now())) / 60000);
    if (quietFor < QUIET_MIN) {
      if (!GATE) console.log(c.dim(`  ${issue.identifier} — PR ${open.map((n) => "#" + n).join(", ")} open but active ${quietFor}m ago; its agent is still working`));
      continue;
    }

    drift++;
    if (GATE) continue;
    console.log(`  ${c.yellow(issue.identifier)} holds a slot but PR ${open.map((n) => "#" + n).join(", ")} is open — ${APPLY ? "moving to In Review" : "would move to In Review"}`);
    console.log(c.dim(`    ${issue.title.slice(0, 70)}`));
    if (!APPLY) continue;
    if (!inReviewId) { console.log(c.red(`    ! no 'In Review' state on team ${repo.team}, skipping`)); continue; }

    // Swap the claim marker for the review marker; keep everything else the
    // agent set. Assignee is left alone — it is who to ask about the PR.
    const keep = (issue.labels?.nodes ?? []).filter((l) => l.name !== "ai:in-progress" && !l.name.startsWith("agent:")).map((l) => l.id);
    const want = [...new Set([...keep, labelId("ai:needs-review")].filter(Boolean))];
    await gql(`mutation($id:String!,$in:IssueUpdateInput!){ issueUpdate(id:$id,input:$in){ success } }`,
      { id: issue.id, in: { stateId: inReviewId, labelIds: want } });
    await gql(`mutation($in:CommentCreateInput!){ commentCreate(input:$in){ success } }`,
      { in: { issueId: issue.id, body:
        `**State reconciled: \`In Progress\` → \`In Review\`.**\n\n` +
        `PR ${open.map((n) => `#${n}`).join(", ")} is open, so the implementation phase is over — but the ticket was still ` +
        `holding a dispatch slot, which caps how many agents can run in this repo.\n\n` +
        `Nothing about the PR was changed. The merge stage reviews it from here.` } });
  }
}

if (GATE) process.exit(drift ? 0 : 1);
if (!drift) console.log(c.dim("\nno drift — every In Progress ticket is genuinely in progress.\n"));
else if (APPLY) console.log(c.dim(`\n${drift} ticket(s) reconciled; those slots are free now.\n`));
else console.log(c.dim(`\n${drift} ticket(s) would be reconciled — re-run with --apply.\n`));
