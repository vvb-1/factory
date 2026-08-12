import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as fake from "./adapters/fake.mjs";
import { startApi } from "./api.mjs";
import { apiClient } from "./client.mjs";
import { openDb } from "./db.mjs";
import { planAdmittedEvents } from "./planner.mjs";
import { loadRegistry } from "./registry.mjs";
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

async function makeServer({ secret = SECRET } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "evrt-api-"));
  const db = openDb(path.join(dir, "runtime.db"));
  const onEvents = [];
  const server = startApi({
    db, registry, secret, policyVersion: PV, port: 0,
    onEvent: (kind) => onEvents.push(kind),
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
    expect(await res.json()).toEqual({ ok: true, policyVersion: PV });
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

    const status = await s.client.status();
    expect(status.events).toEqual({ admitted: 0, planned: 1, noop: 0, human_needed: 0, dead_lettered: 0 });
    expect(status.proposals).toEqual({ open: 0, expired: 0 });
    expect(status.runs.byState).toEqual({ COMPLETED: 1 });
    expect(status.anomalies.expiredOpenProposals).toEqual([]);
    expect(status.anomalies.staleLeases).toBe(0);
    expect(status.anomalies.deadLettered).toEqual([]);
    expect(status.anomalies.unpublishedOutbox).toBe(1); // completion event, not yet published
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
