/**
 * Loopback control API (docs/event-runtime.md §12–§14).
 *
 * Every operator read and verb goes through these endpoints — the TUI/CLI is
 * a client, never the database. The server binds to 127.0.0.1 only: in the
 * MVP the control API is a local trust surface, so there is no authentication
 * story beyond local user access. Webhook intake (§14) verifies the HMAC over
 * the raw body bytes before anything is parsed or written; the replay verb
 * (§13) shares the exact same admission path but, being loopback-only, needs
 * no signature. Operator verbs record "operator" as actor — authenticated
 * actor identity is the web-app step, not this one.
 */
import http from "node:http";
import { API_HOST, DEFAULT_PORT, webhookSecret } from "./config.mjs";
import { admitEvent, verifyWebhook } from "./intake.mjs";
import { IllegalTransition, lifecycleOf } from "./lifecycle.mjs";
import { approveProposal, openProposals, rejectProposal } from "./proposals.mjs";
import { cancelRun, retryRun } from "./worker.mjs";

/** §14 size limit: a control-plane payload has no business being megabytes. */
const MAX_BODY_BYTES = 1024 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("payload_too_large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(json);
}

function parseJson(buffer) {
  try {
    return { value: JSON.parse(buffer.toString("utf8")) };
  } catch (err) {
    return { error: `invalid JSON body: ${err.message}` };
  }
}

/** Shape one open-proposal row for the list view (§12). */
function proposalView(row) {
  return {
    id: row.id,
    decision: row.decision,
    status: row.status,
    expired: row.expired,
    created_at: row.created_at,
    ttl_seconds: row.ttl_seconds,
    reason: row.reason,
    runId: row.run_id,
    agent: row.spec?.agent ?? null,
    spec: row.spec,
  };
}

function eventCounts(db) {
  const counts = { admitted: 0, planned: 0, noop: 0, human_needed: 0, dead_lettered: 0 };
  for (const row of db.query(`SELECT status, COUNT(*) AS n FROM events GROUP BY status`).all()) {
    counts[row.status] = row.n;
  }
  return counts;
}

function runCounts(db) {
  const byState = {};
  for (const row of db.query(`SELECT state, COUNT(*) AS n FROM runs GROUP BY state`).all()) {
    byState[row.state] = row.n;
  }
  return { byState };
}

/** §13 status + doctor view: aggregates plus anomalies, all read-only SQL. */
function statusView(db, nowMs) {
  const open = openProposals(db, { now: nowMs });
  const expiredOpen = open.filter((p) => p.expired);
  const staleLeases = db
    .query(
      `SELECT COUNT(*) AS n FROM runs r
       JOIN attempts a ON a.run_id = r.run_id AND a.attempt = r.attempts
       WHERE r.state IN ('LEASED', 'RUNNING') AND a.lease_expires_at < ?`,
    )
    .get(new Date(nowMs).toISOString()).n;
  const unpublishedOutbox = db
    .query(`SELECT COUNT(*) AS n FROM outbox WHERE published_at IS NULL`)
    .get().n;
  const deadLettered = db
    .query(`SELECT source, event_id, last_plan_error FROM events WHERE status = 'dead_lettered'`)
    .all()
    .map((row) => ({ source: row.source, eventId: row.event_id, lastError: row.last_plan_error }));

  return {
    events: eventCounts(db),
    proposals: { open: open.length, expired: expiredOpen.length },
    runs: runCounts(db),
    anomalies: {
      expiredOpenProposals: expiredOpen.map((p) => p.id),
      staleLeases,
      unpublishedOutbox,
      deadLettered,
    },
  };
}

/**
 * Admitted-event rows with their stored envelope (§13, webui spec §7): the
 * doctor panel's replay verb needs the body, and counts alone cannot show an
 * inbox. Read-only, like every other view here.
 */
function eventsView(db, status) {
  const rows = status
    ? db.query(`SELECT * FROM events WHERE status = ? ORDER BY admitted_at DESC, rowid DESC`).all(status)
    : db.query(`SELECT * FROM events ORDER BY admitted_at DESC, rowid DESC`).all();
  return rows.map((row) => ({
    source: row.source,
    eventId: row.event_id,
    type: row.type,
    subject: row.subject,
    status: row.status,
    occurredAt: row.occurred_at,
    receivedAt: row.received_at,
    correlationId: row.correlation_id,
    planFailures: row.plan_failures,
    lastPlanError: row.last_plan_error,
    admittedAt: row.admitted_at,
    envelope: JSON.parse(row.envelope_json),
  }));
}

function runView(db, runId) {
  const row = db.query(`SELECT * FROM runs WHERE run_id = ?`).get(runId);
  if (!row) return null;
  const attempts = db
    .query(`SELECT * FROM attempts WHERE run_id = ? ORDER BY attempt`)
    .all(runId);
  const result = db
    .query(`SELECT * FROM results WHERE run_id = ? ORDER BY attempt DESC LIMIT 1`)
    .get(runId);
  const latest = attempts[attempts.length - 1];
  return {
    run: {
      runId: row.run_id,
      state: row.state,
      attempts: row.attempts,
      idempotencyKey: row.idempotency_key,
      specHash: row.spec_hash,
      created_at: row.created_at,
      updated_at: row.updated_at,
      spec: JSON.parse(row.spec_json),
    },
    lifecycle: lifecycleOf(db, runId),
    attempts,
    result: result ? JSON.parse(result.result_json) : null,
    receipt: result ? JSON.parse(result.receipt_json) : null,
    workspace: latest?.workspace_path ?? null,
  };
}

/**
 * Both admission routes converge here — the §15 requirement that webhook and
 * replay call the same intake function. onEvent("admitted") lets a foreground
 * serve loop plan immediately instead of waiting a tick.
 */
function admit(db, registry, res, buffer, nowMs, onEvent) {
  const parsed = parseJson(buffer);
  if (parsed.error) return send(res, 422, { errors: [parsed.error] });
  const outcome = admitEvent(db, registry, parsed.value, { now: nowMs });
  if (!outcome.admitted && !outcome.duplicate) return send(res, 422, { errors: outcome.errors });
  if (outcome.admitted) onEvent("admitted");
  return send(res, 200, {
    admitted: outcome.admitted,
    duplicate: outcome.duplicate,
    eventId: outcome.event.event_id,
  });
}

/**
 * Build the request handler. Returned directly (rather than only inside a
 * server) so tests can compose it however they like.
 */
export function createApi({
  db,
  registry,
  secret = webhookSecret(),
  now = () => Date.now(),
  policyVersion = "unknown",
  onEvent = () => {},
} = {}) {
  const ACTOR = "operator"; // one local operator in the MVP (§14)

  return async function handle(req, res) {
    try {
      const url = new URL(req.url, `http://${API_HOST}`);
      const route = `${req.method} ${url.pathname}`;
      const nowMs = now();

      if (route === "GET /health") {
        return send(res, 200, { ok: true, policyVersion });
      }

      if (route === "POST /events") {
        const raw = await readBody(req);
        const verdict = verifyWebhook({
          rawBody: raw,
          signature: req.headers["x-factory-signature"],
          timestamp: req.headers["x-factory-timestamp"],
          secret,
          now: nowMs,
        });
        // Fail closed: nothing is parsed, nothing is written (§14).
        if (!verdict.ok) return send(res, 401, { error: verdict.reason });
        return admit(db, registry, res, raw, nowMs, onEvent);
      }

      if (route === "POST /replay") {
        const raw = await readBody(req);
        return admit(db, registry, res, raw, nowMs, onEvent);
      }

      if (route === "GET /status") {
        return send(res, 200, statusView(db, nowMs));
      }

      if (route === "GET /events") {
        return send(res, 200, { events: eventsView(db, url.searchParams.get("status")) });
      }

      if (route === "GET /proposals") {
        return send(res, 200, { proposals: openProposals(db, { now: nowMs }).map(proposalView) });
      }

      const proposalVerb = url.pathname.match(/^\/proposals\/([^/]+)\/(approve|reject)$/);
      if (req.method === "POST" && proposalVerb) {
        const [, id, verb] = proposalVerb;
        const body = parseJson(await readBody(req)).value ?? {};
        try {
          if (verb === "approve") {
            const outcome = approveProposal(db, registry, id, { actor: ACTOR, now: nowMs, policyVersion });
            if (outcome.approved) return send(res, 200, { approved: true, runId: outcome.runId });
            return send(res, 200, { approved: false, replanned: true, proposal: proposalView({ ...outcome.proposal, expired: false }) });
          }
          const outcome = rejectProposal(db, id, { actor: ACTOR, reason: body.reason, now: nowMs, policyVersion });
          return send(res, 200, { rejected: true, runId: outcome.runId });
        } catch (err) {
          const status = String(err.message).startsWith("unknown proposal") ? 404 : 409;
          return send(res, status, { error: err.message });
        }
      }

      if (route === "GET /runs") {
        const state = url.searchParams.get("state");
        const rows = state
          ? db.query(`SELECT * FROM runs WHERE state = ? ORDER BY created_at DESC, rowid DESC`).all(state)
          : db.query(`SELECT * FROM runs ORDER BY created_at DESC, rowid DESC`).all();
        const runs = rows.map((row) => ({
          runId: row.run_id,
          state: row.state,
          attempts: row.attempts,
          agent: JSON.parse(row.spec_json).agent,
          created_at: row.created_at,
          updated_at: row.updated_at,
        }));
        return send(res, 200, { runs });
      }

      const runVerb = url.pathname.match(/^\/runs\/([^/]+)\/(cancel|retry)$/);
      if (req.method === "POST" && runVerb) {
        const [, runId, verb] = runVerb;
        if (!db.query(`SELECT run_id FROM runs WHERE run_id = ?`).get(runId)) {
          return send(res, 404, { error: `unknown run ${runId}` });
        }
        const body = parseJson(await readBody(req)).value ?? {};
        try {
          if (verb === "cancel") {
            cancelRun(db, runId, { actor: ACTOR, reason: body.reason ?? "operator_cancel", now: nowMs, policyVersion });
            return send(res, 200, { cancelled: true });
          }
          retryRun(db, runId, { actor: ACTOR, force: body.force === true, now: nowMs, policyVersion });
          return send(res, 200, { queued: true });
        } catch (err) {
          if (err instanceof IllegalTransition || err.message === "attempts_exhausted") {
            return send(res, 409, { error: err.message });
          }
          throw err;
        }
      }

      const runGet = url.pathname.match(/^\/runs\/([^/]+)$/);
      if (req.method === "GET" && runGet) {
        const view = runView(db, runGet[1]);
        if (!view) return send(res, 404, { error: `unknown run ${runGet[1]}` });
        return send(res, 200, view);
      }

      return send(res, 404, { error: `no route: ${route}` });
    } catch (err) {
      // Never leak a stack trace across the API boundary.
      if (!res.headersSent) send(res, 500, { error: "internal_error" });
      else res.end();
    }
  };
}

/**
 * Start the control API. Loopback only (§14) — `host` exists for symmetry but
 * defaults to 127.0.0.1 and nothing in the MVP passes anything else.
 */
export function startApi({ port = DEFAULT_PORT, host = API_HOST, ...opts } = {}) {
  const server = http.createServer(createApi(opts));
  server.listen(port, host);
  return server;
}
