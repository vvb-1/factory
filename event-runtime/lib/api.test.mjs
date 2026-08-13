import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as fake from "./adapters/fake.mjs";
import { janitorArgv, startApi } from "./api.mjs";
import { apiClient } from "./client.mjs";
import { openDb } from "./db.mjs";
import { planAdmittedEvents } from "./planner.mjs";
import { loadRegistry } from "./registry.mjs";
import { loadRepos } from "./repos.mjs";
import { runOnce } from "./worker.mjs";

const registry = loadRegistry();
const SECRET = "test-secret";
const PV = "git:test-pv";

let n = 0;
function envelope(overrides = {}) {
  const id = overrides.eventId ?? `evt-${++n}`;
  return {
    schemaVersion: "factory.event/v1",
    eventId: id,
    type: "factory.status-report.requested",
    source: "test",
    subject: "factory",
    occurredAt: new Date().toISOString(),
    correlationId: id,
    causationId: null,
    payload: { repos: ["ok"] },
    ...overrides,
  };
}

/** Await a promise that must reject; returns the error for assertions. */
function rejection(promise) {
  return promise.then(
    () => { throw new Error("expected rejection"); },
    (err) => err,
  );
}

/** Exactly what verifyWebhook expects: HMAC-SHA256 hex of `${ts}.${rawBody}`. */
function sign(rawBody, timestamp, secret = SECRET) {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")}`;
}

async function makeServer({ secret = SECRET, ...opts } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "evrt-api-"));
  const db = openDb(path.join(dir, "runtime.db"));
  const onEvents = [];
  const server = startApi({
    db, registry, secret, policyVersion: PV, port: 0,
    onEvent: (kind) => onEvents.push(kind),
    ...opts,
  });
  await new Promise((resolve) => server.on("listening", resolve));
  const port = server.address().port;
  return {
    db, server, port, onEvents,
    url: (p) => `http://127.0.0.1:${port}${p}`,
    client: apiClient({ port }),
    close: () => {
      server.close();
      db.close();
    },
  };
}

describe("webhook intake (§14)", () => {
  let s;
  beforeAll(async () => {
    s = await makeServer();
  });
  afterAll(() => s.close());

  test("GET /health", async () => {
    const res = await fetch(s.url("/health"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.policyVersion).toBe(PV);
    expect(typeof body.env.name).toBe("string"); // environment identity, always present
  });

  test("unknown route → 404 with an error body", async () => {
    const res = await fetch(s.url("/nope"));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toContain("no route");
  });

  test("valid HMAC → admitted; same delivery again → duplicate", async () => {
    const body = JSON.stringify(envelope({ eventId: "hook-1" }));
    const ts = String(Date.now());
    const headers = {
      "content-type": "application/json",
      "x-factory-timestamp": ts,
      "x-factory-signature": sign(body, ts),
    };

    const first = await fetch(s.url("/events"), { method: "POST", headers, body });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ admitted: true, duplicate: false, eventId: "hook-1" });
    expect(s.onEvents).toEqual(["admitted"]);

    const again = await fetch(s.url("/events"), { method: "POST", headers, body });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ admitted: false, duplicate: true, eventId: "hook-1" });
    expect(s.onEvents).toEqual(["admitted"]); // no second wake-up for a duplicate
  });

  test("bad signature → 401 and nothing written", async () => {
    const before = await (await fetch(s.url("/status"))).json();

    const body = JSON.stringify(envelope({ eventId: "hook-forged" }));
    const ts = String(Date.now());
    const res = await fetch(s.url("/events"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-factory-timestamp": ts,
        "x-factory-signature": sign(body, ts, "wrong-secret"),
      },
      body,
    });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("bad_signature");

    const after = await (await fetch(s.url("/status"))).json();
    expect(after).toEqual(before); // nothing admitted beyond the earlier one
    expect(after.events.admitted).toBe(1);
  });

  test("missing signature → 401", async () => {
    const body = JSON.stringify(envelope({ eventId: "hook-unsigned" }));
    const res = await fetch(s.url("/events"), {
      method: "POST",
      headers: { "content-type": "application/json", "x-factory-timestamp": String(Date.now()) },
      body,
    });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("missing_signature");
  });

  test("GET /events returns the stored envelope; ?status= filters (webui spec §7)", async () => {
    const { events } = await (await fetch(s.url("/events"))).json();
    expect(events).toHaveLength(1);
    expect(events[0].eventId).toBe("hook-1");
    expect(events[0].status).toBe("admitted");
    expect(events[0].envelope.payload).toEqual({ repos: ["ok"] });
    expect(events[0].envelope.eventId).toBe("hook-1");
    expect(events[0].proposalId).toBeNull();
    expect(events[0].runId).toBeNull();

    const filtered = await (await fetch(s.url("/events?status=admitted"))).json();
    expect(filtered.events).toHaveLength(1);
    const none = await (await fetch(s.url("/events?status=dead_lettered"))).json();
    expect(none.events).toEqual([]);
  });

  test("envelope schema failure → 422 with errors, no admission", async () => {
    const body = JSON.stringify({ schemaVersion: "factory.event/v1", eventId: "bad" });
    const ts = String(Date.now());
    const res = await fetch(s.url("/events"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-factory-timestamp": ts,
        "x-factory-signature": sign(body, ts),
      },
      body,
    });
    expect(res.status).toBe(422);
    expect((await res.json()).errors.length).toBeGreaterThan(0);
    expect(s.db.query(`SELECT COUNT(*) AS n FROM events`).get().n).toBe(1);
  });
});

describe("missing configured secret fails closed (§14)", () => {
  test("POST /events → 401 missing_secret; /replay still works", async () => {
    const s = await makeServer({ secret: null });
    try {
      const body = JSON.stringify(envelope({ eventId: "no-secret-1" }));
      const ts = String(Date.now());
      const res = await fetch(s.url("/events"), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-factory-timestamp": ts,
          "x-factory-signature": sign(body, ts),
        },
        body,
      });
      expect(res.status).toBe(401);
      expect((await res.json()).error).toBe("missing_secret");

      const replayed = await s.client.replay(envelope({ eventId: "no-secret-2" }));
      expect(replayed.admitted).toBe(true);
    } finally {
      s.close();
    }
  });
});

describe("watched flow and operator verbs (§12, §13, §15)", () => {
  let s;
  let flowProposalId;
  let flowRunId;
  const workspaces = mkdtempSync(path.join(os.tmpdir(), "evrt-api-ws-"));
  // event-types.json maps to the "claude" adapter; back it with the fake so
  // no real claude process ever spawns in tests.
  const adapters = { claude: fake };
  const workerOpts = () => ({ workspacesRoot: workspaces, owner: "w-test", policyVersion: PV });

  /** Replay + plan one envelope, then return its open proposal via the API. */
  async function planned(eventId) {
    const admitted = await s.client.replay(envelope({ eventId }));
    expect(admitted.admitted).toBe(true);
    planAdmittedEvents(s.db, registry, { policyVersion: PV });
    const { proposals } = await s.client.proposals();
    const mine = proposals.find((p) => p.spec?.idempotencyKey?.includes(eventId));
    expect(mine).toBeTruthy();
    return mine;
  }

  beforeAll(async () => {
    s = await makeServer();
  });
  afterAll(() => s.close());

  test("POST /replay without signature admits (§15 replay verb)", async () => {
    const outcome = await s.client.replay(envelope({ eventId: "flow-1" }));
    expect(outcome).toEqual({ admitted: true, duplicate: false, eventId: "flow-1" });
    expect(s.onEvents).toEqual(["admitted"]);
  });

  test("full watched flow: plan → proposal → approve → QUEUED → runOnce → COMPLETED", async () => {
    expect(planAdmittedEvents(s.db, registry, { policyVersion: PV })).toEqual({
      planned: 1, failed: 0, deadLettered: 0,
    });

    const { proposals } = await s.client.proposals();
    expect(proposals).toHaveLength(1);
    const prop = proposals[0];
    expect(prop.decision).toBe("run");
    expect(prop.expired).toBe(false);
    expect(prop.agent).toBe("factory-status-report@1");
    expect(prop.spec.adapter).toBe("claude");
    expect(prop.ttl_seconds).toBe(1800);
    flowProposalId = prop.id;

    const approved = await s.client.approve(prop.id);
    expect(approved).toEqual({ approved: true, runId: prop.runId });
    flowRunId = approved.runId;

    const queued = await s.client.run(flowRunId);
    expect(queued.run.state).toBe("QUEUED");

    const summary = await runOnce(s.db, registry, adapters, workerOpts());
    expect(summary.terminalState).toBe("COMPLETED");

    const done = await s.client.run(flowRunId);
    expect(done.run.state).toBe("COMPLETED");
    expect(done.run.spec.agent).toBe("factory-status-report@1");
    expect(done.result.terminalState).toBe("completed");
    expect(done.result.artifactHash).toMatch(/^sha256:/);
    expect(done.receipt.verificationStatus).toBe("passed");
    expect(done.receipt.artifactHash).toBe(done.result.artifactHash);
    expect(done.lifecycle.map((e) => e.to_state)).toEqual([
      "PROPOSED", "APPROVED", "QUEUED", "LEASED", "RUNNING", "VERIFYING", "COMPLETED",
    ]);
    expect(done.attempts).toHaveLength(1);
    expect(done.attempts[0].terminal_state).toBe("COMPLETED");

    const list = await s.client.runs();
    expect(list.runs.map((r) => r.runId)).toContain(flowRunId);
    expect(list.runs[0].agent).toBe("factory-status-report@1");
    expect((await s.client.runs("COMPLETED")).runs).toHaveLength(1);
    expect((await s.client.runs("QUEUED")).runs).toHaveLength(0);

    const { events } = await s.client.events("planned");
    expect(events.map((e) => e.eventId)).toContain("flow-1");
    expect(events[0].envelope.type).toBe("factory.status-report.requested");

    const status = await s.client.status();
    expect(status.events).toEqual({ admitted: 0, planned: 1, noop: 0, human_needed: 0, dead_lettered: 0 });
    expect(status.proposals).toEqual({ open: 0, expired: 0 });
    expect(status.runs.byState).toEqual({ COMPLETED: 1 });
    expect(status.anomalies.expiredOpenProposals).toEqual([]);
    expect(status.anomalies.staleLeases).toBe(0);
    expect(status.anomalies.deadLettered).toEqual([]);
    expect(status.anomalies.unpublishedOutbox).toBe(1); // completion event, not yet published
    expect(status.anomalies.ambiguousOpenProposals).toEqual([]);
  });

  test("approve unknown proposal → 404; approve twice → 409", async () => {
    const unknown = await rejection(s.client.approve("prop_nope"));
    expect(unknown.status).toBe(404);
    expect(unknown.message).toBe("unknown proposal prop_nope");

    const again = await rejection(s.client.approve(flowProposalId));
    expect(again.status).toBe(409);
    expect(again.message).toContain("not open");
  });

  test("reject an open proposal → run CANCELLED", async () => {
    const prop = await planned("rej-1");
    const rejected = await s.client.reject(prop.id, "not today");
    expect(rejected.rejected).toBe(true);

    const run = await s.client.run(prop.runId);
    expect(run.run.state).toBe("CANCELLED");
    expect(run.lifecycle.at(-1).reason).toBe("proposal_rejected");
    expect(run.lifecycle.at(-1).actor).toBe("operator");

    const rejectAgain = await rejection(s.client.reject(prop.id, "again"));
    expect(rejectAgain.status).toBe(409);
    expect(rejectAgain.message).toContain("not open");
  });

  test("cancel a QUEUED run → 200; cancel again → 409; unknown run → 404", async () => {
    const prop = await planned("can-1");
    const { runId } = await s.client.approve(prop.id);
    expect((await s.client.run(runId)).run.state).toBe("QUEUED");

    expect(await s.client.cancel(runId, "changed my mind")).toEqual({ cancelled: true });
    const view = await s.client.run(runId);
    expect(view.run.state).toBe("CANCELLED");
    expect(view.lifecycle.at(-1).actor).toBe("operator");

    const again = await rejection(s.client.cancel(runId));
    expect(again.status).toBe(409);
    expect(again.message).toContain("illegal transition");

    const unknown = await rejection(s.client.cancel("run_nope"));
    expect(unknown.status).toBe(404);
    expect(unknown.message).toBe("unknown run run_nope");
  });

  test("cancel a PROPOSED run closes its open proposal", async () => {
    const prop = await planned("can-proposed-1");
    expect((await s.client.run(prop.runId)).run.state).toBe("PROPOSED");
    expect((await s.client.proposals()).proposals.map((p) => p.id)).toContain(prop.id);

    expect(await s.client.cancel(prop.runId, "never mind")).toEqual({ cancelled: true });
    expect((await s.client.run(prop.runId)).run.state).toBe("CANCELLED");

    const open = await s.client.proposals();
    expect(open.proposals.map((p) => p.id)).not.toContain(prop.id);

    const history = await s.client.proposals("all");
    const decided = history.proposals.find((p) => p.id === prop.id);
    expect(decided.status).toBe("rejected");
    expect(decided.reason).toBe("run_cancelled");
    expect(decided.decided_by).toBe("operator");
  });

  test("cancel with two open proposals still cancels and signals the ambiguity", async () => {
    const prop = await planned("can-ambiguous-1");
    const at = new Date().toISOString();
    s.db.query(
      `INSERT INTO proposals (id, event_source, event_id, run_id, decision, created_at, ttl_seconds)
       VALUES (?, ?, ?, ?, 'run', ?, 1800)`,
    ).run("prop_extra_ambiguous", prop.eventSource, prop.eventId, prop.runId, at);

    expect(await s.client.cancel(prop.runId, "never mind")).toEqual({
      cancelled: true,
      ambiguousOpenProposals: 2,
    });
    expect((await s.client.run(prop.runId)).run.state).toBe("CANCELLED");

    const open = await s.client.proposals();
    expect(open.proposals.map((p) => p.id)).toContain(prop.id);
    expect(open.proposals.map((p) => p.id)).toContain("prop_extra_ambiguous");

    const status = await s.client.status();
    expect(status.anomalies.ambiguousOpenProposals).toEqual([
      { runId: prop.runId, count: 2 },
    ]);
  });

  test("retry: 404 on unknown run, 409 when attempts are exhausted, queued with force", async () => {
    const prop = await planned("retry-1");
    const { runId } = await s.client.approve(prop.id);
    // Deterministic terminal FAILED: run with an empty adapters map so the
    // spec's "claude" adapter is unknown (no requeue, attempts consumed).
    const summary = await runOnce(s.db, registry, {}, workerOpts());
    expect(summary.runId).toBe(runId);
    expect(summary.terminalState).toBe("FAILED");
    expect(summary.reasonCode).toBe("unknown_adapter");

    const exhausted = await rejection(s.client.retry(runId));
    expect(exhausted.status).toBe(409);
    expect(exhausted.message).toBe("attempts_exhausted");

    expect(await s.client.retry(runId, { force: true })).toEqual({ queued: true });
    expect((await s.client.run(runId)).run.state).toBe("QUEUED");
    await s.client.cancel(runId, "test cleanup");

    const unknown = await rejection(s.client.retry("run_nope"));
    expect(unknown.status).toBe(404);
    expect(unknown.message).toBe("unknown run run_nope");
  });
});

describe("webui surface: proposal linkage, history, journal, outbox, requeue (OPS-212)", () => {
  test("proposals carry their originating event; history filter works; runs list is enriched", async () => {
    const { db, server, port } = await makeServer();
    const client = apiClient({ port });
    try {
      await client.replay(envelope({ eventId: "link-1" }));
      planAdmittedEvents(db, registry, { policyVersion: PV, adapterOverride: "fake" });

      const { proposals } = await client.proposals();
      expect(proposals).toHaveLength(1);
      expect(proposals[0].eventId).toBe("link-1");
      expect(proposals[0].eventSource).toBe("test");

      await client.approve(proposals[0].id);
      await runOnce(db, registry, { claude: fake, fake }, {
        workspacesRoot: mkdtempSync(path.join(os.tmpdir(), "evrt-ws-")),
        owner: "test-worker", policyVersion: PV,
      });

      const history = await client.proposals("approved");
      expect(history.proposals).toHaveLength(1);
      expect(history.proposals[0].decided_by).toBe("operator");
      expect((await client.proposals("all")).proposals.length).toBeGreaterThanOrEqual(1);

      const { runs } = await client.runs();
      expect(runs[0].state).toBe("COMPLETED");
      expect(runs[0].reasonCode).toBe("ok");
      expect(runs[0].eventId).toBe("link-1");
      expect(runs[0].adapter).toBe("fake");
      expect(runs[0].maxAttempts).toBe(1);

      const { events } = await client.events();
      expect(events[0].eventId).toBe("link-1");
      expect(events[0].proposalId).toBe(proposals[0].id);
      expect(events[0].runId).toBe(runs[0].runId);
    } finally {
      server.close();
    }
  });

  test("journal feed pages by seq and outbox lists published result events", async () => {
    const { db, server, port } = await makeServer();
    const client = apiClient({ port });
    try {
      await client.replay(envelope({ eventId: "feed-1" }));
      planAdmittedEvents(db, registry, { policyVersion: PV, adapterOverride: "fake" });
      const { proposals } = await client.proposals();
      await client.approve(proposals[0].id);
      await runOnce(db, registry, { claude: fake, fake }, {
        workspacesRoot: mkdtempSync(path.join(os.tmpdir(), "evrt-ws-")),
        owner: "test-worker", policyVersion: PV,
      });

      const journal = await client.journal();
      expect(journal.head).toBeGreaterThan(0);
      expect(journal.entries.map((e) => e.to)).toContain("COMPLETED");
      const after = await client.journal({ since: journal.head });
      expect(after.entries).toHaveLength(0);
      expect(after.head).toBe(journal.head);

      const { outbox } = await client.outbox();
      expect(outbox).toHaveLength(1);
      expect(outbox[0].event.type).toBe("factory.status-report.completed");
      expect(outbox[0].published_at).toBeNull(); // no serve loop in this test — sink not run
    } finally {
      server.close();
    }
  });

  test("requeue recovers a dead-lettered event and refuses everything else", async () => {
    const { db, server, port, onEvents } = await makeServer();
    const client = apiClient({ port });
    try {
      await client.replay(envelope({ eventId: "dead-1" }));
      db.query(`UPDATE events SET status = 'dead_lettered', plan_failures = 3, last_plan_error = 'boom' WHERE event_id = 'dead-1'`).run();

      expect((await client.requeue("test", "dead-1")).requeued).toBe(true);
      expect(onEvents).toContain("requeued");
      const { events } = await client.events("admitted");
      expect(events.map((e) => e.eventId)).toContain("dead-1");
      expect(events.find((e) => e.eventId === "dead-1").planFailures).toBe(0);

      const again = await rejection(client.requeue("test", "dead-1"));
      expect(again.status).toBe(409); // now admitted — not requeueable
      const missing = await rejection(client.requeue("test", "ghost"));
      expect(missing.status).toBe(404);
    } finally {
      server.close();
    }
  });

  test("requeueing a human_needed event supersedes its open proposal", async () => {
    const { db, server, port } = await makeServer();
    const client = apiClient({ port });
    try {
      await client.replay(envelope({ eventId: "hn-1", type: "unregistered.event.type" }));
      planAdmittedEvents(db, registry, { policyVersion: PV });
      const before = await client.proposals();
      expect(before.proposals[0].decision).toBe("human_needed");

      await client.requeue("test", "hn-1");
      expect((await client.proposals()).proposals).toHaveLength(0); // superseded, inbox clean
      const superseded = await client.proposals("superseded");
      expect(superseded.proposals[0].eventId).toBe("hn-1");
    } finally {
      server.close();
    }
  });
});

describe("environment identity (webui chip)", () => {
  test("health and status expose the env the server was started with", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "evrt-env-"));
    const db = openDb(path.join(dir, "runtime.db"));
    const server = startApi({
      db, registry, secret: SECRET, policyVersion: PV, port: 0,
      env: { name: "dev", home: dir, adapter: "fake" },
    });
    await new Promise((resolve) => server.on("listening", resolve));
    const client = apiClient({ port: server.address().port });
    try {
      const health = await client.health();
      expect(health.env).toEqual({ name: "dev", home: dir, adapter: "fake" });
      expect((await client.status()).env.name).toBe("dev");
    } finally {
      server.close();
    }
  });
});

describe("artifact store and agent registry surfacing (OPS-212)", () => {
  test("declared artifacts and the transcript survive the workspace and stream from the API", async () => {
    const { db, server, port } = await makeServer();
    const client = apiClient({ port });
    const home = mkdtempSync(path.join(os.tmpdir(), "evrt-home-"));
    try {
      await client.replay(envelope({ eventId: "art-1", payload: { repos: ["with-artifact"] } }));
      planAdmittedEvents(db, registry, { policyVersion: PV, adapterOverride: "fake" });
      const { proposals } = await client.proposals();
      await client.approve(proposals[0].id);
      const summary = await runOnce(db, registry, { claude: fake, fake }, {
        workspacesRoot: path.join(home, "workspaces"),
        artifactStore: path.join(home, "artifacts"),
        owner: "test-worker", policyVersion: PV,
      });
      expect(summary.terminalState).toBe("COMPLETED");

      const view = await client.run(summary.runId);
      const kinds = view.result.artifacts.map((a) => a.kind).sort();
      expect(kinds).toEqual(["report", "transcript"]);
      // Workspace is gone; every artifact URI must point into the store and exist.
      for (const a of view.result.artifacts) {
        expect(a.uri).toContain("/artifacts/");
        expect(a.sizeBytes).toBeGreaterThan(0);
      }
    } finally {
      server.close();
    }
  });

  test("GET /artifacts/:hash streams stored bytes; unknown and malformed hashes 404", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "evrt-home-"));
    const db = openDb(path.join(home, "runtime.db"));
    const server = startApi({
      db, registry, secret: SECRET, policyVersion: PV, port: 0,
      env: { name: "test", home, adapter: "fake" },
    });
    await new Promise((resolve) => server.on("listening", resolve));
    const port = server.address().port;
    const client = apiClient({ port });
    try {
      await client.replay(envelope({ eventId: "art-2", payload: { repos: ["with-artifact"] } }));
      planAdmittedEvents(db, registry, { policyVersion: PV, adapterOverride: "fake" });
      await client.approve((await client.proposals()).proposals[0].id);
      const summary = await runOnce(db, registry, { claude: fake, fake }, {
        workspacesRoot: path.join(home, "workspaces"),
        artifactStore: path.join(home, "artifacts"),
        owner: "test-worker", policyVersion: PV,
      });

      const view = await client.run(summary.runId);
      const report = view.result.artifacts.find((a) => a.kind === "report");
      const res = await fetch(`http://127.0.0.1:${port}/artifacts/${report.sha256}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/plain");
      expect(await res.text()).toBe("fake report for with-artifact\n");

      expect((await fetch(`http://127.0.0.1:${port}/artifacts/${"0".repeat(64)}`)).status).toBe(404);
      expect((await fetch(`http://127.0.0.1:${port}/artifacts/not-a-hash`)).status).toBe(404);
    } finally {
      server.close();
    }
  });

  test("GET /runs/:id/trace pages incrementally; 404 unknown; empty for an untraced run (OPS-295)", async () => {
    const { db, server, port } = await makeServer();
    const client = apiClient({ port });
    try {
      await client.replay(envelope({ eventId: "trace-1", payload: { repos: ["ok"] } }));
      planAdmittedEvents(db, registry, { policyVersion: PV, adapterOverride: "fake" });
      await client.approve((await client.proposals()).proposals[0].id);
      const summary = await runOnce(db, registry, { claude: fake, fake }, {
        workspacesRoot: mkdtempSync(path.join(os.tmpdir(), "evrt-ws-")),
        owner: "test-worker", policyVersion: PV,
      });
      expect(summary.terminalState).toBe("COMPLETED");

      // Page 1: two entries; head already points at the last row for the run.
      const first = await client.trace(summary.runId, { limit: 2 });
      expect(first.entries.map((e) => e.kind)).toEqual(["assistant_text", "tool_use"]);
      expect(first.head).toBeGreaterThan(first.entries.at(-1).seq);

      // Page 2: resume from the last seen seq, get the rest.
      const rest = await client.trace(summary.runId, { since: first.entries.at(-1).seq });
      expect(rest.entries.map((e) => e.kind)).toEqual(["tool_result", "usage"]);
      expect(rest.head).toBe(rest.entries.at(-1).seq);
      expect(rest.entries[0].attempt).toBe(1);
      expect(typeof rest.entries[0].ts).toBe("string");

      // Caught up: since=head → no entries, head unchanged.
      const done = await client.trace(summary.runId, { since: rest.head });
      expect(done).toEqual({ head: rest.head, entries: [] });

      // Unknown run → 404, matching GET /runs/:id.
      const unknown = await rejection(client.trace("run_nope"));
      expect(unknown.status).toBe(404);
      expect(unknown.message).toBe("unknown run run_nope");

      // A run that exists but never traced → head 0, empty entries.
      await client.replay(envelope({ eventId: "trace-2", payload: { repos: ["ok"] } }));
      planAdmittedEvents(db, registry, { policyVersion: PV, adapterOverride: "fake" });
      const open = (await client.proposals()).proposals[0];
      const { runId: queuedRun } = await client.approve(open.id);
      expect(await client.trace(queuedRun)).toEqual({ head: 0, entries: [] });
    } finally {
      server.close();
    }
  });

  test("GET /agents exposes definitions, prompt text, schemas, pins, and routing", async () => {
    const { server, port } = await makeServer();
    const client = apiClient({ port });
    try {
      const { agents: defs, contracts } = await client.agents();
      const def = defs.find((d) => d.ref === "factory-status-report@1");
      expect(def.prompt).toContain("factory-status-report@1");
      expect(def.outputSchema.required).toContain("recommendedAction");
      expect(Object.keys(def.pins)).toHaveLength(3);
      expect(def.eventTypes[0].type).toBe("factory.status-report.requested");
      expect(def.mutating).toBe(false);
      expect(contracts["factory.agent-result/v1"].properties.terminalState.enum).toContain("refused");
    } finally {
      server.close();
    }
  });

  test("GET /repos serves the repos.yaml registry, dispatch mode included (OPS-299)", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "evrt-api-repos-"));
    mkdirSync(path.join(root, "config"), { recursive: true });
    writeFileSync(
      path.join(root, "config", "repos.yaml"),
      `repos:\n  - name: dispatchable\n    path: ~/Develop/dispatchable\n    github: watt-mind/dispatchable\n    team: CLNT\n    base: develop\n    deploy_branch: master\n    worktree_down: bin/worktree-down.sh\n    worktree_root: ~/Develop/.worktrees/dispatchable\n    max_in_flight: 20\n    escalate_paths:\n      - src/auth/**\n  - name: watched\n    path: ~/Develop/watched\n    team: OPS\n    report_only: true\n`,
    );
    const { server, port, close } = await makeServer({ repos: () => loadRepos({ root }) });
    const client = apiClient({ port });
    try {
      const { repos: rows } = await client.repos();
      expect(rows.map((r) => r.name)).toEqual(["dispatchable", "watched"]);
      expect(rows[0]).toEqual({
        name: "dispatchable",
        path: path.join(process.env.HOME ?? "", "Develop/dispatchable"),
        github: "watt-mind/dispatchable",
        team: "CLNT",
        project: null,
        base: "develop",
        deployBranch: "master",
        reportOnly: false,
        maxInFlight: 20,
        worktreeRoot: path.join(process.env.HOME ?? "", "Develop/.worktrees/dispatchable"),
        hasWorktreeUp: false,
        hasWorktreeDown: true,
        hasWorktreeWarm: false,
        verify: null,
      });
      expect(rows[1]).toMatchObject({ reportOnly: true, maxInFlight: null, hasWorktreeDown: false });
      // Merge-policy paths are config, not registry: the wire never carries them.
      expect(JSON.stringify(rows)).not.toContain("src/auth");
    } finally {
      close();
      server.close();
    }
  });

  test("GET /repos names a missing repos.yaml instead of a bare internal_error", async () => {
    const empty = mkdtempSync(path.join(os.tmpdir(), "evrt-api-norepos-"));
    const { server, port, close } = await makeServer({ repos: () => loadRepos({ root: empty }) });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/repos`);
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toContain("no repos config at");
      expect(body.error).not.toBe("internal_error");
    } finally {
      close();
      server.close();
    }
  });

  test("POST /repos/:name/janitor dry-runs by default and never calls apply (OPS-301)", async () => {
    const calls = [];
    const fixture = new Map([
      ["dispatchable", { name: "dispatchable", reportOnly: false, worktreeDown: "bin/worktree-down.sh" }],
    ]);
    const { server, port, close } = await makeServer({
      repos: () => fixture,
      janitor: async (name, opts) => {
        calls.push({ name, apply: opts.apply });
        return { name, reclaimable: [{ id: "OPS-1", state: "Done" }], kept: [], named: [], unknown: [], removed: [], refused: [] };
      },
    });
    const client = apiClient({ port });
    try {
      const body = await client.janitor("dispatchable");
      expect(body.actor).toBe("operator");
      expect(body.apply).toBe(false);
      expect(body.reclaimable).toEqual([{ id: "OPS-1", state: "Done" }]);
      expect(calls).toEqual([{ name: "dispatchable", apply: false }]);
    } finally {
      close();
      server.close();
    }
  });

  test("POST /repos/:name/janitor apply true reaches the injected janitor (OPS-301)", async () => {
    const calls = [];
    const fixture = new Map([
      ["dispatchable", { name: "dispatchable", reportOnly: false, worktreeDown: "bin/worktree-down.sh" }],
    ]);
    const { server, port, close } = await makeServer({
      repos: () => fixture,
      janitor: async (name, opts) => {
        calls.push({ name, apply: opts.apply });
        return { name, reclaimable: [{ id: "OPS-1", state: "Done" }], removed: ["OPS-1"], refused: [], kept: [], named: [], unknown: [] };
      },
    });
    const client = apiClient({ port });
    try {
      const body = await client.janitor("dispatchable", { apply: true });
      expect(body.apply).toBe(true);
      expect(body.removed).toEqual(["OPS-1"]);
      expect(calls).toEqual([{ name: "dispatchable", apply: true }]);
    } finally {
      close();
      server.close();
    }
  });

  test("POST /repos/:name/janitor 404s an unknown repo without spawning (OPS-301)", async () => {
    let spawned = false;
    const { server, port, close } = await makeServer({
      repos: () => new Map([["dispatchable", { name: "dispatchable", reportOnly: false, worktreeDown: "bin/worktree-down.sh" }]]),
      janitor: async () => {
        spawned = true;
        return {};
      },
    });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/repos/nope/janitor`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "unknown repo nope" });
      expect(spawned).toBe(false);
    } finally {
      close();
      server.close();
    }
  });

  test("POST /repos/:name/janitor apply on report_only without worktree_down is 409 (OPS-301)", async () => {
    let spawned = false;
    const { server, port, close } = await makeServer({
      repos: () => new Map([["watched", { name: "watched", reportOnly: true, worktreeDown: null }]]),
      janitor: async () => {
        spawned = true;
        return {};
      },
    });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/repos/watched/janitor`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apply: true }),
      });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toMatch(/report-only repo "watched" has no worktree_down/);
      expect(spawned).toBe(false);
    } finally {
      close();
      server.close();
    }
  });

  test("POST /repos/:name/janitor rejects a non-boolean apply (OPS-301)", async () => {
    const { server, port, close } = await makeServer({
      repos: () => new Map([["dispatchable", { name: "dispatchable", reportOnly: false, worktreeDown: "bin/worktree-down.sh" }]]),
      janitor: async () => ({}),
    });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/repos/dispatchable/janitor`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apply: "please" }),
      });
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({ error: "apply must be a boolean" });
    } finally {
      close();
      server.close();
    }
  });

  test("janitorArgv never includes --force and adds --apply only when asked (OPS-301)", () => {
    const dry = janitorArgv("bj29");
    expect(dry).toContain("--json");
    expect(dry).toContain("bj29");
    expect(dry).not.toContain("--force");
    expect(dry).not.toContain("--apply");
    const apply = janitorArgv("bj29", { apply: true });
    expect(apply).toContain("--apply");
    expect(apply).not.toContain("--force");
    expect(apply.filter((a) => a === "--apply")).toHaveLength(1);
  });
});
