/**
 * Durable human inbox ledger (WM-285).
 *
 * An inbox row is written before its Telegram projection is attempted. The
 * ledger therefore remains authoritative even when the transport is absent or
 * broken, while notify_log continues to provide runtime-notification dedup.
 */
import { randomUUID } from "node:crypto";
import {
  decisionRequestHash,
  validateDecisionRequest,
  validateDecisionResponse,
} from "./decision.mjs";
import { applyDecisionEffect } from "./decision-effects.mjs";
import {
  replannedProposalContext,
  templateFor,
} from "./decision-templates.mjs";
import { txImmediate } from "./db.mjs";

export const INBOX_KINDS = Object.freeze([
  "BLOCKED",
  "ESCALATED",
  "CI RED",
  "SMOKE RED",
  "CIRCUIT BREAKER",
  "RC READY",
  "human_needed",
  "decision_needed",
  "proposal_expired",
]);

const KIND_SET = new Set(INBOX_KINDS);
const STATUSES = new Set(["open", "acked", "resolved", "all"]);
const REF_KEYS = new Set([
  "runId",
  "proposalId",
  "eventSource",
  "eventId",
  "issue",
  "pr",
  "repo",
]);

function requiredString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function optionalString(value, name) {
  if (value === undefined || value === null) return null;
  return requiredString(value, name);
}

function normalizeRefs(refs) {
  if (refs === undefined || refs === null) return {};
  if (typeof refs !== "object" || Array.isArray(refs))
    throw new Error("refs must be an object");
  const normalized = {};
  for (const [key, value] of Object.entries(refs)) {
    if (!REF_KEYS.has(key)) throw new Error(`unknown inbox ref ${key}`);
    if (value === undefined || value === null) continue;
    normalized[key] = requiredString(value, `refs.${key}`);
  }
  return normalized;
}

function parseObject(value) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function parseNullableObject(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

export class InboxDecisionError extends Error {
  constructor(code, message, status = 400, errors = undefined) {
    super(message);
    this.name = "InboxDecisionError";
    this.code = code;
    this.status = status;
    if (errors) this.errors = errors;
  }
}

export function itemView(row) {
  if (!row) return null;
  // Answers that were archived rather than kept (retargets, §6) ride in
  // delivery_json: the v6 ledger has no column for them, and that blob already
  // carries WM-390's supersededDecisions counter. Lift them out so the view
  // reads as a ledger field and `delivery` stays about the projection.
  const { responseHistory, ...delivery } = parseObject(row.delivery_json);
  return {
    id: row.id,
    kind: row.kind,
    severity: row.severity,
    title: row.title,
    body: row.body ?? null,
    refs: parseObject(row.refs_json),
    source: row.source,
    createdAt: row.created_at,
    ackedAt: row.acked_at ?? null,
    resolvedAt: row.resolved_at ?? null,
    resolvedBy: row.resolved_by ?? null,
    resolvedReason: row.resolved_reason ?? null,
    delivery: parseObject(row.delivery_json),
    decision: parseNullableObject(row.decision_json),
    response: parseNullableObject(row.response_json),
    responseHistory: Array.isArray(responseHistory) ? responseHistory : [],
    decidedAt: row.decided_at ?? null,
    decidedBy: row.decided_by ?? null,
    dedupeKey: row.dedupe_key ?? null,
  };
}

export function getInboxItem(db, id) {
  return itemView(db.query("SELECT * FROM inbox_items WHERE id = ?").get(id));
}

function supersedeInboxDecision(db, row, { body, refs, decision }) {
  const updated = db
    .query(
      `UPDATE inbox_items
     SET decision_json = ?, response_json = NULL, decided_at = NULL,
         decided_by = NULL, body = ?,
         refs_json = CASE WHEN ? IS NULL THEN refs_json ELSE json_set(
           CASE WHEN json_valid(refs_json) THEN refs_json ELSE '{}' END,
           '$.runId', ?
         ) END,
         delivery_json = json_set(
           CASE WHEN json_valid(delivery_json) THEN delivery_json ELSE '{}' END,
           '$.supersededDecisions',
           COALESCE(json_extract(
             CASE WHEN json_valid(delivery_json) THEN delivery_json ELSE '{}' END,
             '$.supersededDecisions'
           ), 0) + 1
         )
     WHERE id = ? AND resolved_at IS NULL`,
    )
    .run(
      decision === null ? null : JSON.stringify(decision),
      body,
      refs.runId ?? null,
      refs.runId ?? null,
      row.id,
    );
  if (updated.changes !== 1) return null;
  return getInboxItem(db, row.id);
}

export function createInboxItem(
  db,
  input,
  { id = `inbox_${randomUUID()}`, now = Date.now() } = {},
) {
  const kind = requiredString(input?.kind, "kind");
  if (!KIND_SET.has(kind)) throw new Error(`unknown inbox kind: ${kind}`);
  const title = requiredString(input?.title, "title");
  const body = optionalString(input?.body, "body");
  const severity = optionalString(input?.severity, "severity") ?? "normal";
  const source = optionalString(input?.source, "source") ?? "cli";
  if (
    source !== "cli" &&
    source !== "serve:notify" &&
    !/^agent:.+/.test(source)
  ) {
    throw new Error(`unknown inbox source: ${source}`);
  }
  const refs = normalizeRefs(input?.refs);
  const decision = input?.decision ?? null;
  if (decision !== null) {
    const checked = validateDecisionRequest(decision, { refs });
    if (!checked.valid) {
      throw new InboxDecisionError(
        "invalid_decision",
        `invalid decision request: ${checked.errors.join("; ")}`,
        400,
        checked.errors,
      );
    }
  }
  const dedupeKey = optionalString(input?.dedupeKey, "dedupeKey");
  const createdAt = new Date(now).toISOString();

  if (dedupeKey) {
    const existing = db
      .query(
        `SELECT * FROM inbox_items
       WHERE dedupe_key = ? AND resolved_at IS NULL
       LIMIT 1`,
      )
      .get(dedupeKey);
    if (existing) {
      const superseded = supersedeInboxDecision(db, existing, {
        body,
        refs,
        decision,
      });
      if (superseded) return superseded;
    }
  }

  let insertError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      db.query(
        `INSERT INTO inbox_items
           (id, kind, severity, title, body, refs_json, source, created_at,
            delivery_json, decision_json, dedupe_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?)`,
      ).run(
        id,
        kind,
        severity,
        title,
        body,
        JSON.stringify(refs),
        source,
        createdAt,
        decision === null ? null : JSON.stringify(decision),
        dedupeKey,
      );
      return getInboxItem(db, id);
    } catch (err) {
      insertError = err;
      // A second connection can win the partial-unique-index race after the
      // lookup above. In that case the collision has the same semantics as an
      // item that was already present; unrelated insert failures still escape.
      const winner = dedupeKey
        ? db
            .query(
              `SELECT * FROM inbox_items
           WHERE dedupe_key = ? AND resolved_at IS NULL
           LIMIT 1`,
            )
            .get(dedupeKey)
        : null;
      if (!winner) break;
      const superseded = supersedeInboxDecision(db, winner, {
        body,
        refs,
        decision,
      });
      if (superseded) return superseded;
      // The winner resolved between the read and update, releasing the
      // partial unique key. Retry the insert once as a new ledger item.
    }
  }
  throw insertError;
}

function decisionRow(db, id) {
  const row = db.query("SELECT * FROM inbox_items WHERE id = ?").get(id);
  if (!row) {
    throw new InboxDecisionError("not_found", `unknown inbox item ${id}`, 404);
  }
  return row;
}

/** WM-391: the approve found the proposal expired and re-planned it instead. */
const REPLANNED_DETAIL = "replanned_awaiting_approval";

/**
 * Move the WM-390 v5 dedupe key (`<kind>:<primary ref>`) onto the fresh
 * proposal, so the next producer for it supersedes this item instead of
 * stacking a second one. A key that is not the proposal formula is left alone
 * rather than guessed at.
 */
function retargetedDedupeKey(db, row, previousProposalId, proposalId) {
  const current = row.dedupe_key ?? null;
  const suffix = previousProposalId ? `:${previousProposalId}` : null;
  if (!current || !suffix || !current.endsWith(suffix)) return current;
  const next = `${current.slice(0, -suffix.length)}:${proposalId}`;
  // inbox_items_open_dedupe is unique across open rows. Taking a key another
  // open item already holds would abort the transaction and lose the answer,
  // so leave ours behind and let that item own the fresh proposal.
  const taken = db
    .query(
      `SELECT id FROM inbox_items
     WHERE dedupe_key = ? AND resolved_at IS NULL AND id <> ?
     LIMIT 1`,
    )
    .get(next, row.id);
  return taken ? current : next;
}

/**
 * Point a decided item at the proposal a re-plan opened, and re-open it.
 *
 * One statement moves refs, the fresh request, the dedupe key, and the
 * archived answer together while clearing `decided_at`/`decided_by`, so no
 * reader sees the item half-retargeted — pointing at the superseded proposal
 * with the new request installed, or decided against a question nobody asked.
 */
function retargetInboxDecision(db, id, answer, proposalId, { now }) {
  const row = decisionRow(db, id);
  const refs = parseObject(row.refs_json);
  const previousProposalId = refs.proposalId ?? null;
  const nextRefs = { ...refs, proposalId };
  const request = templateFor(row.kind, {
    producer: "proposal",
    refs: nextRefs,
    context: replannedProposalContext(previousProposalId, proposalId),
  });
  const checked = validateDecisionRequest(request, { refs: nextRefs });
  if (!checked.valid) {
    // Fail closed. Rolling the whole decision back leaves the operator on the
    // original, answerable request; installing this would leave them holding
    // an item nobody can decide.
    throw new InboxDecisionError(
      "retarget_failed",
      `inbox item ${id} could not be retargeted to ${proposalId}: ${checked.errors.join("; ")}`,
      500,
      checked.errors,
    );
  }

  const { responseHistory, ...delivery } = parseObject(row.delivery_json);
  const history = Array.isArray(responseHistory) ? responseHistory : [];
  db.query(
    `UPDATE inbox_items
     SET refs_json = ?, decision_json = ?, dedupe_key = ?, delivery_json = ?,
         response_json = NULL, decided_at = NULL, decided_by = NULL
     WHERE id = ?`,
  ).run(
    JSON.stringify(nextRefs),
    JSON.stringify(request),
    retargetedDedupeKey(db, row, previousProposalId, proposalId),
    JSON.stringify({
      ...delivery,
      responseHistory: [
        ...history,
        {
          retargetedFrom: previousProposalId,
          retargetedTo: proposalId,
          retargetedAt: new Date(now).toISOString(),
          response: answer,
        },
      ],
    }),
    id,
  );
  return getInboxItem(db, id);
}

/**
 * Record the effect outcome on the answer and settle the item.
 *
 * An `approve_proposal` on an expired proposal re-plans rather than approves
 * (WM-391), so the operator bought a fresh undecided proposal, not a decision.
 * Resolving on that `applied` outcome dropped the approve and left the new
 * proposal with no inbox item (WM-714); retarget the row instead.
 */
function settleInboxDecision(
  db,
  id,
  response,
  effect,
  { now, recordedEffect = effect },
) {
  const answer = { ...response, effect: recordedEffect };
  const replanned =
    effect.outcome === "applied" && effect.detail === REPLANNED_DETAIL;
  if (
    replanned &&
    typeof effect.newProposalId === "string" &&
    effect.newProposalId.trim() !== ""
  ) {
    return {
      item: retargetInboxDecision(db, id, answer, effect.newProposalId, {
        now,
      }),
      effect,
    };
  }
  db.query("UPDATE inbox_items SET response_json = ? WHERE id = ?").run(
    JSON.stringify(answer),
    id,
  );
  // A re-plan with no fresh id is a broken effect — WM-391 throws on it rather
  // than returning one. Leave the item open and retryable instead of resolving
  // on a detail the ledger cannot act on.
  if (effect.outcome === "applied" && !replanned) {
    db.query(
      `UPDATE inbox_items
       SET resolved_at = COALESCE(resolved_at, ?),
           resolved_by = COALESCE(resolved_by, ?)
       WHERE id = ?`,
    ).run(new Date(now).toISOString(), `operator:${effect.kind}`, id);
  }
  return { item: getInboxItem(db, id), effect };
}

function normalizeEffect(effect, item, response) {
  const kind =
    item.decision.options.find((option) => option.id === response.optionId)
      ?.effect ?? "unknown";
  if (!effect || typeof effect !== "object" || Array.isArray(effect)) {
    return {
      kind,
      outcome: "failed",
      error: "decision effect returned no outcome",
    };
  }
  return { ...effect, kind };
}

/** Validate, record, and apply one response to a stored decision request. */
function decideInboxItemInTransaction(
  db,
  id,
  response,
  {
    now = Date.now(),
    decidedBy = "operator",
    applyEffect = applyDecisionEffect,
  } = {},
) {
  const row = decisionRow(db, id);
  const decision = parseNullableObject(row.decision_json);
  if (!decision) {
    throw new InboxDecisionError(
      "decision_missing",
      `inbox item ${id} has no decision request`,
      400,
    );
  }
  if (row.response_json || row.decided_at) {
    throw new InboxDecisionError(
      "already_decided",
      `inbox item ${id} is already decided`,
      409,
    );
  }
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    throw new InboxDecisionError(
      "invalid_response",
      "response must be an object",
      400,
    );
  }
  const expectedHash = decisionRequestHash(decision);
  if (
    typeof response.requestHash === "string" &&
    /^sha256:[a-f0-9]{64}$/.test(response.requestHash) &&
    response.requestHash !== expectedHash
  ) {
    throw new InboxDecisionError(
      "stale_request",
      `inbox item ${id} decision request has changed`,
      409,
    );
  }

  const decidedAt = new Date(now).toISOString();
  const storedResponse = {
    ...response,
    decidedBy,
    decidedAt,
  };
  const checked = validateDecisionResponse(storedResponse, decision);
  if (!checked.valid) {
    throw new InboxDecisionError(
      "invalid_response",
      `invalid decision response: ${checked.errors.join("; ")}`,
      400,
      checked.errors,
    );
  }

  // Persist the answer before invoking the seam. A throwing effect must not
  // lose what the operator entered; retry uses this exact stored response.
  const recorded = db
    .query(
      `UPDATE inbox_items
     SET response_json = ?, decided_at = ?, decided_by = ?
     WHERE id = ? AND response_json IS NULL AND decided_at IS NULL`,
    )
    .run(JSON.stringify(storedResponse), decidedAt, decidedBy, id);
  if (recorded.changes !== 1) {
    throw new InboxDecisionError(
      "already_decided",
      `inbox item ${id} is already decided`,
      409,
    );
  }

  const item = getInboxItem(db, id);
  let effect;
  try {
    effect = normalizeEffect(
      applyEffect(db, item, storedResponse),
      item,
      storedResponse,
    );
  } catch (err) {
    effect = normalizeEffect(
      { outcome: "failed", error: err?.message ?? String(err) },
      item,
      storedResponse,
    );
  }
  return settleInboxDecision(db, id, storedResponse, effect, { now });
}

export function decideInboxItem(db, id, response, options = {}) {
  // Serialize request claim, effect application, and finalization against
  // concurrent answers and dedupe supersession on other connections.
  return txImmediate(db, () =>
    decideInboxItemInTransaction(db, id, response, options),
  );
}

/** Retry the effect for an answer that was already recorded. */
function retryInboxDecisionInTransaction(
  db,
  id,
  {
    now = Date.now(),
    applyEffect = applyDecisionEffect,
    expectedResponseJson,
  } = {},
) {
  const row = decisionRow(db, id);
  if (row.response_json !== expectedResponseJson) {
    throw new InboxDecisionError(
      "retry_superseded",
      `inbox item ${id} decision retry was superseded`,
      409,
    );
  }
  const decision = parseNullableObject(row.decision_json);
  const recorded = parseNullableObject(row.response_json);
  if (!decision || !recorded || !row.decided_at) {
    throw new InboxDecisionError(
      "not_decided",
      `inbox item ${id} has not been decided`,
      409,
    );
  }
  if (row.resolved_at || recorded.effect?.outcome === "applied") {
    throw new InboxDecisionError(
      "already_applied",
      `inbox item ${id} decision effect is already applied`,
      409,
    );
  }
  const retryAttempt = Number(recorded.effect?.retryAttempt ?? 0) + 1;
  const { effect: _priorEffect, ...response } = recorded;
  const item = getInboxItem(db, id);
  let effect;
  try {
    effect = normalizeEffect(applyEffect(db, item, response), item, response);
  } catch (err) {
    effect = normalizeEffect(
      { outcome: "failed", error: err?.message ?? String(err) },
      item,
      response,
    );
  }
  return settleInboxDecision(db, id, response, effect, {
    now,
    recordedEffect: { ...effect, retryAttempt },
  });
}

export function retryInboxDecision(db, id, options = {}) {
  // Capture the exact failed outcome before waiting for the write lock. A
  // concurrent retry increments retryAttempt, so a waiter cannot replay the
  // same effect after that first retry commits; a later deliberate retry can.
  const expectedResponseJson =
    db.query("SELECT response_json FROM inbox_items WHERE id = ?").get(id)
      ?.response_json ?? null;
  // The same lock prevents two operators from retrying one effect at once.
  return txImmediate(db, () =>
    retryInboxDecisionInTransaction(db, id, {
      ...options,
      expectedResponseJson,
    }),
  );
}

export function listInboxItems(db, { status = "open" } = {}) {
  if (!STATUSES.has(status)) throw new Error(`unknown inbox status: ${status}`);
  const where = {
    open: "resolved_at IS NULL AND acked_at IS NULL",
    acked: "resolved_at IS NULL AND acked_at IS NOT NULL",
    resolved: "resolved_at IS NOT NULL",
    all: "1 = 1",
  }[status];
  return db
    .query(
      `SELECT * FROM inbox_items WHERE ${where} ORDER BY created_at DESC, rowid DESC`,
    )
    .all()
    .map(itemView);
}

export function ackInboxItem(db, id, { now = Date.now() } = {}) {
  const row = db
    .query("SELECT resolved_at FROM inbox_items WHERE id = ?")
    .get(id);
  if (!row) throw new Error(`unknown inbox item ${id}`);
  if (row.resolved_at) throw new Error(`inbox item ${id} is already resolved`);
  db.query(
    "UPDATE inbox_items SET acked_at = COALESCE(acked_at, ?) WHERE id = ?",
  ).run(new Date(now).toISOString(), id);
  return getInboxItem(db, id);
}

export function resolveInboxItem(
  db,
  id,
  { now = Date.now(), resolvedBy = "operator", reason } = {},
) {
  requiredString(resolvedBy, "resolvedBy");
  const resolvedReason = optionalString(reason, "reason");
  if (
    resolvedBy !== "operator" &&
    !resolvedBy.startsWith("auto:") &&
    !resolvedBy.startsWith("operator:")
  ) {
    throw new Error(`invalid inbox resolver: ${resolvedBy}`);
  }
  const row = db
    .query(
      "SELECT id, decision_json, response_json FROM inbox_items WHERE id = ?",
    )
    .get(id);
  if (!row) throw new Error(`unknown inbox item ${id}`);
  const resolvedAt = new Date(now).toISOString();
  if (row.decision_json && !row.response_json) {
    if (!resolvedBy.startsWith("auto:")) {
      const err = new Error(`inbox item ${id} has a pending decision`);
      err.code = "decision_pending";
      throw err;
    }
    // The runtime observed the referent leave its waiting state, so the ask is
    // moot. Record a superseded response so a late operator answer is refused
    // as already_decided instead of applying an effect nobody wants any more.
    db.query(
      `UPDATE inbox_items
       SET response_json = ?, decided_at = ?, decided_by = ?
       WHERE id = ? AND response_json IS NULL AND decided_at IS NULL`,
    ).run(
      JSON.stringify({
        superseded: true,
        reason: resolvedBy,
        decidedBy: resolvedBy,
        decidedAt: resolvedAt,
      }),
      resolvedAt,
      resolvedBy,
      id,
    );
  }
  db.query(
    `UPDATE inbox_items
     SET resolved_at = COALESCE(resolved_at, ?),
         resolved_by = COALESCE(resolved_by, ?),
         resolved_reason = COALESCE(resolved_reason, ?)
     WHERE id = ?`,
  ).run(resolvedAt, resolvedBy, resolvedReason, id);
  return getInboxItem(db, id);
}

export function inboxCounts(db) {
  const totals = db
    .query(
      `SELECT
       SUM(CASE WHEN resolved_at IS NULL AND acked_at IS NULL THEN 1 ELSE 0 END) AS open,
       SUM(CASE WHEN resolved_at IS NULL AND acked_at IS NOT NULL THEN 1 ELSE 0 END) AS acked
     FROM inbox_items`,
    )
    .get();
  const byKind = {};
  for (const row of db
    .query(
      `SELECT kind, COUNT(*) AS n FROM inbox_items
     WHERE resolved_at IS NULL GROUP BY kind ORDER BY kind`,
    )
    .all()) {
    byKind[row.kind] = row.n;
  }
  return {
    open: Number(totals.open ?? 0),
    acked: Number(totals.acked ?? 0),
    byKind,
  };
}

function telegramMessage(item, webUrl) {
  const lines = [item.title];
  if (item.body) lines.push(item.body);
  if (item.decision) {
    lines.push(item.decision.question);
    item.decision.options.forEach((option, index) => {
      lines.push(`${index + 1}. ${option.label}`);
    });
  }
  const content = lines.join("\n");
  if (!webUrl) return content;
  return `${content}\n${String(webUrl).replace(/\/$/, "")}/#/inbox/${encodeURIComponent(item.id)}`;
}

/** Attempt the Telegram projection and persist its outcome on the existing row. */
export async function deliverInboxItem(
  db,
  id,
  {
    command,
    send,
    webUrl = process.env.FACTORY_WEB_URL,
    now = Date.now(),
  } = {},
) {
  const item = getInboxItem(db, id);
  if (!item) throw new Error(`unknown inbox item ${id}`);
  if (typeof send !== "function")
    throw new Error("inbox delivery transport is required");
  let outcome;
  try {
    outcome = await send(command, telegramMessage(item, webUrl));
  } catch (err) {
    outcome = { ok: false, exitCode: null, error: err.message };
  }
  // Read the stored blob rather than the view: the view lifts responseHistory
  // out of it, and writing the view back would drop the archived answers.
  const stored = parseObject(
    db.query("SELECT delivery_json FROM inbox_items WHERE id = ?").get(id)
      ?.delivery_json,
  );
  const delivery = {
    ...stored,
    telegram: {
      sent_at: new Date(now).toISOString(),
      exit_code: outcome.exitCode ?? null,
      error: outcome.error ?? null,
    },
  };
  db.query("UPDATE inbox_items SET delivery_json = ? WHERE id = ?").run(
    JSON.stringify(delivery),
    id,
  );
  return {
    ok: outcome.ok === true,
    exitCode: outcome.exitCode ?? null,
    error: outcome.error ?? null,
    item: getInboxItem(db, id),
  };
}

/** Resolve runtime-owned asks when their authoritative referent stops waiting. */
export function reconcileInbox(db, { now = Date.now() } = {}) {
  const resolved = [];
  const rows = db
    .query(
      `SELECT id, kind, refs_json, decision_json, response_json FROM inbox_items
     WHERE resolved_at IS NULL
       AND kind IN ('decision_needed', 'proposal_expired', 'human_needed', 'BLOCKED')
     ORDER BY created_at, rowid`,
    )
    .all();
  for (const row of rows) {
    // Pending decisions are not skipped: once the referent stops waiting the
    // ask is moot and resolveInboxItem records it as superseded (auto:*).
    const refs = parseObject(row.refs_json);
    let resolvedBy = null;
    if (row.kind === "decision_needed" || row.kind === "proposal_expired") {
      if (!refs.proposalId) continue;
      const proposal = db
        .query("SELECT status FROM proposals WHERE id = ?")
        .get(refs.proposalId);
      if (proposal && proposal.status !== "open")
        resolvedBy = "auto:proposal_decided";
    } else if (refs.eventSource && refs.eventId) {
      const event = db
        .query("SELECT status FROM events WHERE source = ? AND event_id = ?")
        .get(refs.eventSource, refs.eventId);
      if (event && event.status !== "human_needed")
        resolvedBy = "auto:event_requeued";
    }
    if (!resolvedBy) continue;
    resolveInboxItem(db, row.id, { now, resolvedBy });
    resolved.push({ id: row.id, resolvedBy });
  }
  return resolved;
}
