import { describe, expect, test } from "bun:test";
import { makeServer } from "./api-test-helpers.mjs";
import { createHookRegistry } from "./hooks.mjs";

describe("metrics proposal drill-down filters (WM-282)", () => {
  const now = Date.parse("2026-08-18T10:00:00.000Z");
  const from = "2026-08-18T08:00:00.000Z";
  const to = "2026-08-18T10:00:00.000Z";

  function insertProposal(
    db,
    id,
    { status, createdAt, decidedAt = null, ttl = 3600 },
  ) {
    db.query(
      `INSERT INTO proposals
         (id, event_source, event_id, decision, status, created_at, ttl_seconds, decided_at, spec_json)
       VALUES (?, 'test', ?, 'run', ?, ?, ?, ?, '{}')`,
    ).run(id, `event-${id}`, status, createdAt, ttl, decidedAt);
  }

  test("decision population includes recorded and truthful virtual expiry timestamps", async () => {
    const s = await makeServer({ now: () => now });
    try {
      insertProposal(s.db, "proposal-approved", {
        status: "approved",
        createdAt: "2026-08-18T08:00:00.000Z",
        decidedAt: "2026-08-18T08:30:00.000Z",
      });
      insertProposal(s.db, "proposal-expired-open", {
        status: "open",
        createdAt: "2026-08-18T07:30:00.000Z",
        ttl: 3600,
      });
      insertProposal(s.db, "proposal-future-open", {
        status: "open",
        createdAt: "2026-08-18T09:30:00.000Z",
        ttl: 3600,
      });

      const approved = await fetch(
        s.url(
          `/proposals?status=all&population=decision&from=${from}&to=${to}&decisionStatus=approved`,
        ),
      );
      expect(approved.status).toBe(200);
      expect(
        (await approved.json()).proposals.map((proposal) => proposal.id),
      ).toEqual(["proposal-approved"]);

      const expired = await fetch(
        s.url(
          `/proposals?status=all&population=decision&from=${from}&to=${to}&decisionStatus=expired`,
        ),
      );
      expect(expired.status).toBe(200);
      const rows = (await expired.json()).proposals;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: "proposal-expired-open",
        status: "expired",
        expired: true,
      });
      expect(rows[0].decided_at).toBe("2026-08-18T08:30:00.000Z");
    } finally {
      s.close();
    }
  });

  test("rejects incomplete and unknown proposal populations", async () => {
    const s = await makeServer({ now: () => now });
    try {
      const incomplete = await fetch(
        s.url("/proposals?status=all&population=decision"),
      );
      expect(incomplete.status).toBe(422);
      expect((await incomplete.json()).error).toBe("incomplete_time_filter");
      const unknown = await fetch(
        s.url(`/proposals?status=all&population=usage&from=${from}&to=${to}`),
      );
      expect(unknown.status).toBe(422);
      expect((await unknown.json()).error).toBe("invalid_population");
    } finally {
      s.close();
    }
  });
});

describe("GET /proposals/:id (WM-842)", () => {
  const now = Date.parse("2026-08-19T12:00:00.000Z");

  test("returns the proposal with its approve.before hook decisions, oldest first; unknown id is 404", async () => {
    const s = await makeServer({ now: () => now });
    try {
      s.db
        .query(
          `INSERT INTO proposals
             (id, event_source, event_id, run_id, decision, status, created_at, ttl_seconds, spec_json, reason)
           VALUES ('gated', 'chain', 'event-gated', 'run-gated', 'run', 'open', ?, 1800, ?, ?)`,
        )
        .run(
          new Date(now - 60_000).toISOString(),
          JSON.stringify({ agent: "dispatch@1", input: { repo: "factory" } }),
          "auto_approval_ineligible:dispatch_ineligible:repo_gated",
        );
      const hooks = createHookRegistry();
      hooks.register(
        "approve.before",
        {
          id: "acme/x:gate",
          default: () => ({ decision: "deny", reason: "repo_gated" }),
        },
        { source: "extension:acme/x" },
      );
      hooks.run(
        "approve.before",
        {
          proposal: { id: "gated", runId: "run-gated" },
          evidence: { ticket: { labels: [] } },
        },
        { db: s.db, now },
      );

      const res = await fetch(s.url("/proposals/gated"));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.proposal).toMatchObject({
        id: "gated",
        status: "open",
        expired: false,
        runId: "run-gated",
        agent: "dispatch@1",
        repos: ["factory"],
        reason: "auto_approval_ineligible:dispatch_ineligible:repo_gated",
      });
      expect(
        body.hookDecisions.map((d) => [
          d.hookId,
          d.source,
          d.decision,
          d.reason,
        ]),
      ).toEqual([
        ["factory:escalation-labels", "builtin", "allow", null],
        ["acme/x:gate", "extension:acme/x", "deny", "repo_gated"],
      ]);
      expect(body.hookDecisions[0]).toMatchObject({
        at: new Date(now).toISOString(),
        point: "approve.before",
        proposalId: "gated",
        runId: "run-gated",
        error: null,
      });

      const missing = await fetch(s.url("/proposals/nope"));
      expect(missing.status).toBe(404);
      expect((await missing.json()).error).toMatch(/unknown proposal nope/);

      // A proposal with no decisions yet still answers, with an empty list.
      s.db
        .query(
          `INSERT INTO proposals (id, event_source, event_id, decision, status, created_at, ttl_seconds, spec_json)
           VALUES ('fresh', 'test', 'event-fresh', 'run', 'open', ?, 60, '{}')`,
        )
        .run(new Date(now - 120_000).toISOString());
      const fresh = await (await fetch(s.url("/proposals/fresh"))).json();
      expect(fresh.hookDecisions).toEqual([]);
      expect(fresh.proposal.expired).toBe(true);
    } finally {
      s.close();
    }
  });
});
