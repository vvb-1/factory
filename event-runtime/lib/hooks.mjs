/**
 * Hooks — typed, decision-returning interception points (WM-842,
 * docs/extensions.md § Hooks).
 *
 * The policy that gates unattended work lives in lib/auto-approval.mjs. A
 * hook is how an operator adds a gate without forking it: a module declared
 * in an extension manifest (`contributes.hooks`), imported in-process by the
 * loader, and asked for a decision at a named point. This ticket ships one
 * point, `approve.before`, evaluated by `autoApproveChains` immediately before
 * each chain auto-approval; the built-in escalation-label refusal runs on it
 * as the first hook (lib/hooks/builtin/escalation-labels.mjs).
 *
 * Contract of a hook module:
 *
 *   export const id = "publisher/extension:hook-name";
 *   export default function (ctx) {          // may be async
 *     return { decision: "allow" } | { decision: "deny", reason: "why" };
 *   }
 *
 * Properties this module owns:
 *
 *   1. **Waterfall, built-ins first.** `run` calls the hooks of a point in
 *      order — every `builtin` source in registration order, then extension
 *      hooks in the order the loader registered them (policy.yaml
 *      `extensions:` order). The first `deny` ends the run.
 *   2. **Fail closed.** A hook that throws, rejects, returns anything other
 *      than a well-formed decision, or does not answer within `timeoutMs`
 *      (default 2000) is a `deny` with reason `hook_error:<id>`. Nothing a
 *      hook does can widen what would have been approved without it.
 *   3. **Every decision is persisted.** Allow and deny alike append a row to
 *      the module-owned `hook_decisions` table (the `notify_log` pattern of
 *      lib/notify.mjs; auxiliary tables stay out of db.mjs), read back by
 *      `GET /proposals/:id` and counted on `GET /status`.
 *   4. **Synchronous when it can be.** `run` returns the decision directly
 *      when every hook answered synchronously and a Promise as soon as one
 *      hook returns a thenable. `autoApproveChains` relies on this so a pass
 *      with only synchronous hooks (the built-in one) still completes before
 *      `planAdmittedEvents` returns, exactly as before this seam existed;
 *      callers that do not need that guarantee simply `await` the result.
 *
 * `defaultHookRegistry()` is the process-wide registry the loader fills and
 * `autoApproveChains` reads by default (mirroring `getExtensionConfig`, which
 * reads the loader's last run); tests build their own with
 * `createHookRegistry()` and pass it through the options seams.
 */
import escalationLabels, * as escalationLabelsModule from "./hooks/builtin/escalation-labels.mjs";

/** The points a hook may be registered on. Widening is a ticket per point. */
export const HOOK_POINTS = Object.freeze(["approve.before"]);

/** Source recorded on hooks the runtime ships. Extension hooks use `extension:<name>`. */
export const BUILTIN_HOOK_SOURCE = "builtin";

/** A hook that has not answered by then is a deny (`hook_error:<id>`). */
export const DEFAULT_HOOK_TIMEOUT_MS = 2000;

/** Decisions older than this do not count on `/status`. */
export const HOOK_DECISION_WINDOW_MS = 24 * 60 * 60 * 1000;

const HOOK_ID_PATTERN = /^[a-z0-9-]+(\/[a-z0-9-]+)?:[a-z0-9][a-z0-9-]*$/;
const REASON_PATTERN = /^[A-Za-z0-9_.:/-]{1,120}$/;

/** Typed error for registry misuse (unknown point, bad module, duplicate id). */
export class HookError extends Error {
  /**
   * @param {string} code - `hook_point_unknown` | `hook_module_invalid` | `hook_duplicate` | `hook_source_missing`
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = "HookError";
    this.code = code;
  }
}

/**
 * Prove a module satisfies the hook contract without calling it: a `default`
 * export that is a function and a string `id` shaped `publisher[/ext]:name`.
 * Throws a HookError naming the fault; the loader turns that into the anomaly
 * that disables the extension.
 *
 * @param {unknown} module
 * @returns {{ id: string, fn: Function }}
 */
export function validateHookModule(module) {
  if (typeof module !== "object" || module === null) {
    throw new HookError(
      "hook_module_invalid",
      "hook module must be an ES module namespace or object",
    );
  }
  if (typeof module.default !== "function") {
    throw new HookError(
      "hook_module_invalid",
      "hook module must export a default function (ctx) => decision",
    );
  }
  if (typeof module.id !== "string" || !HOOK_ID_PATTERN.test(module.id)) {
    throw new HookError(
      "hook_module_invalid",
      `hook module must export a string id matching ${HOOK_ID_PATTERN} (got ${JSON.stringify(module.id ?? null)})`,
    );
  }
  return { id: module.id, fn: module.default };
}

/**
 * Module-owned audit table. Idempotent; called before every write and by the
 * read helpers only when the table exists (status/proposal views stay
 * read-only SQL).
 */
export function ensureHookDecisions(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS hook_decisions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    at          TEXT NOT NULL,
    point       TEXT NOT NULL,
    hook_id     TEXT NOT NULL,
    source      TEXT NOT NULL,
    proposal_id TEXT,
    run_id      TEXT,
    decision    TEXT NOT NULL,
    reason      TEXT,
    duration_ms INTEGER NOT NULL,
    error       TEXT
  );`);
  db.exec(
    `CREATE INDEX IF NOT EXISTS hook_decisions_proposal ON hook_decisions (proposal_id);`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS hook_decisions_at ON hook_decisions (at);`,
  );
}

function hasHookDecisions(db) {
  return !!db
    .query(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'hook_decisions'`,
    )
    .get();
}

function decisionRow(row) {
  return {
    id: row.id,
    at: row.at,
    point: row.point,
    hookId: row.hook_id,
    source: row.source,
    proposalId: row.proposal_id,
    runId: row.run_id,
    decision: row.decision,
    reason: row.reason,
    durationMs: row.duration_ms,
    error: row.error,
  };
}

/**
 * Every persisted decision for one proposal, oldest first — what
 * `GET /proposals/:id` returns as `hookDecisions`.
 *
 * @returns {Array<{ at: string, point: string, hookId: string, source: string, proposalId: string|null, runId: string|null, decision: string, reason: string|null, durationMs: number, error: string|null }>}
 */
export function hookDecisionsFor(db, proposalId) {
  if (!hasHookDecisions(db)) return [];
  return db
    .query(`SELECT * FROM hook_decisions WHERE proposal_id = ? ORDER BY id`)
    .all(proposalId)
    .map(decisionRow);
}

/**
 * Allow/deny counts per hook id over the trailing window (24h by default) —
 * what `GET /status` publishes under `hooks.decisions24h`.
 *
 * @param {import("bun:sqlite").Database} db
 * @param {{ now?: number, windowMs?: number }} [options]
 * @returns {Record<string, { source: string, point: string, allow: number, deny: number }>}
 */
export function hookDecisionCounts(
  db,
  { now = Date.now(), windowMs = HOOK_DECISION_WINDOW_MS } = {},
) {
  if (!hasHookDecisions(db)) return {};
  const since = new Date(now - windowMs).toISOString();
  const rows = db
    .query(
      `SELECT hook_id, source, point, decision, COUNT(*) AS n
         FROM hook_decisions
        WHERE at >= ?
        GROUP BY hook_id, source, point, decision
        ORDER BY hook_id`,
    )
    .all(since);
  const out = {};
  for (const row of rows) {
    const entry = (out[row.hook_id] ??= {
      source: row.source,
      point: row.point,
      allow: 0,
      deny: 0,
    });
    if (row.decision === "allow") entry.allow += row.n;
    else if (row.decision === "deny") entry.deny += row.n;
  }
  return out;
}

function isThenable(value) {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof value.then === "function"
  );
}

/** Deep-copy JSON-ish context so a hook cannot mutate what the guard reads next. */
function cloneContext(ctx) {
  const out = {};
  for (const [key, value] of Object.entries(ctx ?? {})) {
    out[key] =
      typeof value === "object" && value !== null
        ? structuredClone(value)
        : value;
  }
  return out;
}

class HookTimeout extends Error {
  constructor(id, ms) {
    super(`hook ${id} did not answer within ${ms}ms`);
    this.name = "HookTimeout";
  }
}

function withTimeout(promise, id, ms) {
  let timer;
  const expiry = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new HookTimeout(id, ms)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, expiry]).finally(() => clearTimeout(timer));
}

/**
 * Create a registry. Built-ins are registered first with source `builtin`;
 * the extension loader adds the rest with `register()`.
 *
 * @param {{ builtins?: Array<{ point: string, module: object }> }} [options]
 */
export function createHookRegistry({ builtins = builtinHooks() } = {}) {
  /** @type {Array<{ point: string, id: string, source: string, fn: Function, config: Function|undefined }>} */
  const hooks = [];

  const summary = (hook) => ({
    point: hook.point,
    id: hook.id,
    source: hook.source,
  });

  const ordered = (point) => {
    const builtin = [];
    const rest = [];
    for (const hook of hooks) {
      if (hook.point !== point) continue;
      (hook.source === BUILTIN_HOOK_SOURCE ? builtin : rest).push(hook);
    }
    return [...builtin, ...rest];
  };

  /**
   * Validate and add one hook.
   *
   * @param {string} point - one of HOOK_POINTS
   * @param {unknown} module - a module with `default(ctx)` and `id`
   * @param {{ source: string, config?: () => unknown }} options - `source` is
   *   mandatory (`builtin` or `extension:<name>`) so every persisted decision
   *   says where its hook came from; `config` is a getter for the `ctx.config`
   *   the hook receives (the loader passes the extension's effective config).
   * @returns {{ point: string, id: string, source: string }}
   */
  function register(point, module, { source, config } = {}) {
    if (!HOOK_POINTS.includes(point)) {
      throw new HookError(
        "hook_point_unknown",
        `unknown hook point "${point}" (known: ${HOOK_POINTS.join(", ")})`,
      );
    }
    const { id, fn } = validateHookModule(module);
    if (typeof source !== "string" || source === "") {
      throw new HookError(
        "hook_source_missing",
        `register() needs { source } saying where hook ${id} came from`,
      );
    }
    if (config !== undefined && typeof config !== "function") {
      throw new HookError(
        "hook_module_invalid",
        `register() option config for hook ${id} must be a function`,
      );
    }
    const existing = hooks.find((hook) => hook.id === id);
    if (existing) {
      throw new HookError(
        "hook_duplicate",
        `hook id "${id}" is already registered from ${existing.source}`,
      );
    }
    const hook = { point, id, source, fn, config };
    hooks.push(hook);
    return summary(hook);
  }

  /** Remove one hook by id; returns whether it was registered. */
  function unregister(id) {
    const index = hooks.findIndex((hook) => hook.id === id);
    if (index === -1) return false;
    hooks.splice(index, 1);
    return true;
  }

  /**
   * Run the waterfall for one point.
   *
   * @param {string} point
   * @param {object} ctx - `{ proposal, spec, evidence, policy, repo, now }`;
   *   `config` is added per hook. Hooks receive a deep copy.
   * @param {{ timeoutMs?: number, db?: import("bun:sqlite").Database, now?: number }} [options] -
   *   `db` persists every decision to `hook_decisions`; without it nothing is
   *   written (pure registry tests). `now` stamps the rows.
   * @returns {HookRun | Promise<HookRun>} the deciding hook's decision, or an
   *   `allow` with `hookId: null` when no hook denied. Synchronous unless a
   *   hook returned a thenable.
   * @typedef {{ decision: "allow"|"deny", reason: string|null, hookId: string|null, source: string|null, durationMs: number, decisions: Array<{ hookId: string, source: string, decision: string, reason: string|null, durationMs: number, error: string|null }> }} HookRun
   */
  function run(point, ctx = {}, options = {}) {
    if (!HOOK_POINTS.includes(point)) {
      throw new HookError(
        "hook_point_unknown",
        `unknown hook point "${point}" (known: ${HOOK_POINTS.join(", ")})`,
      );
    }
    const {
      timeoutMs = DEFAULT_HOOK_TIMEOUT_MS,
      db,
      now = Date.now(),
    } = options;
    const chain = ordered(point);
    const decisions = [];
    const startedAll = performance.now();
    if (db) ensureHookDecisions(db);

    const record = (hook, decision, reason, durationMs, error) => {
      const entry = {
        hookId: hook.id,
        source: hook.source,
        decision,
        reason,
        durationMs,
        error,
      };
      decisions.push(entry);
      if (db) {
        db.query(
          `INSERT INTO hook_decisions
             (at, point, hook_id, source, proposal_id, run_id, decision, reason, duration_ms, error)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          new Date(now).toISOString(),
          point,
          hook.id,
          hook.source,
          ctx?.proposal?.id ?? null,
          ctx?.proposal?.runId ?? null,
          decision,
          reason,
          durationMs,
          error,
        );
      }
      return entry;
    };

    // Interpret one hook's answer (value or error) into a recorded decision.
    const settle = (hook, started, value, error) => {
      const durationMs = Math.round(performance.now() - started);
      const failClosed = (why) =>
        record(hook, "deny", `hook_error:${hook.id}`, durationMs, why);
      if (error !== undefined) {
        return failClosed(String(error?.message ?? error));
      }
      if (durationMs > timeoutMs) {
        return failClosed(
          `hook ${hook.id} took ${durationMs}ms > ${timeoutMs}ms`,
        );
      }
      if (typeof value !== "object" || value === null) {
        return failClosed(
          `hook returned ${value === null ? "null" : typeof value}, not a decision`,
        );
      }
      if (value.decision === "allow") {
        return record(hook, "allow", null, durationMs, null);
      }
      if (value.decision === "deny") {
        if (
          typeof value.reason !== "string" ||
          !REASON_PATTERN.test(value.reason)
        ) {
          return failClosed(
            `deny without a well-formed reason (${JSON.stringify(value.reason ?? null)})`,
          );
        }
        return record(hook, "deny", value.reason, durationMs, null);
      }
      return failClosed(
        `unknown decision ${JSON.stringify(value.decision ?? null)}`,
      );
    };

    const finish = (last) => ({
      decision: last?.decision === "deny" ? "deny" : "allow",
      reason: last?.decision === "deny" ? last.reason : null,
      hookId: last?.decision === "deny" ? last.hookId : null,
      source: last?.decision === "deny" ? last.source : null,
      durationMs: Math.round(performance.now() - startedAll),
      decisions,
    });

    const step = (index) => {
      for (let i = index; i < chain.length; i += 1) {
        const hook = chain[i];
        const started = performance.now();
        let value;
        try {
          const hookCtx = cloneContext(ctx);
          hookCtx.config = hook.config ? hook.config() : undefined;
          value = hook.fn(hookCtx);
        } catch (err) {
          return finish(settle(hook, started, undefined, err ?? "thrown"));
        }
        if (isThenable(value)) {
          return withTimeout(Promise.resolve(value), hook.id, timeoutMs)
            .then(
              (resolved) => settle(hook, started, resolved, undefined),
              (err) => settle(hook, started, undefined, err ?? "rejected"),
            )
            .then((entry) =>
              entry.decision === "deny" ? finish(entry) : step(i + 1),
            );
        }
        const entry = settle(hook, started, value, undefined);
        if (entry.decision === "deny") return finish(entry);
      }
      return finish(null);
    };

    return step(0);
  }

  for (const { point, module } of builtins ?? []) {
    register(point, module, { source: BUILTIN_HOOK_SOURCE });
  }

  return Object.freeze({
    register,
    unregister,
    run,
    has: (id) => hooks.some((hook) => hook.id === id),
    /** Hooks in run order: built-ins first, then extensions as registered. */
    list: () => HOOK_POINTS.flatMap((point) => ordered(point).map(summary)),
  });
}

/** The hooks the runtime ships, in the order they run. */
export function builtinHooks() {
  return [
    {
      point: "approve.before",
      module: { id: escalationLabelsModule.id, default: escalationLabels },
    },
  ];
}

let DEFAULT_REGISTRY = null;

/**
 * The process-wide registry: built-ins plus whatever `loadExtensions`
 * registered. `autoApproveChains` reads it unless given `{ hooks }`.
 */
export function defaultHookRegistry() {
  DEFAULT_REGISTRY ??= createHookRegistry();
  return DEFAULT_REGISTRY;
}
