import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, artifactUrl } from "../api";
import { hashPath } from "../hash";
import { useListKeys, useNow, useTabKeys } from "../hooks";
import { setContextActions } from "../palette";
import type { RunState } from "../types";
import {
  Ago,
  Button,
  Dialog,
  Disclosure,
  FilterInput,
  ListPane,
  DetailPane,
  humanSize,
  JsonBlock,
  JumpLink,
  KV,
  ListEmpty,
  notify,
  Section,
  StateBadge,
  VerbError,
  copyText,
  copyLink,
} from "../components/ui";

const STATE_TABS: (RunState | "ALL")[] = [
  "ALL", "QUEUED", "LEASED", "RUNNING", "VERIFYING", "COMPLETED", "REFUSED", "FAILED", "TIMED_OUT", "CANCELLED",
];
const TERMINAL: RunState[] = ["COMPLETED", "REFUSED", "FAILED", "TIMED_OUT", "CANCELLED"];

function rowWash(state: string): string {
  if (state === "FAILED" || state === "TIMED_OUT") return "row-wash-err";
  if (state === "REFUSED") return "row-wash-warn";
  return "";
}

/**
 * A worker id is minted as `worker_<pid>_<rand>` (lib/ids.mjs); every other
 * actor the runtime records is a bare word — `operator`, `planner`, `reaper`,
 * or the `worker` fallback for an attempt whose owner was lost. Only the
 * prefixed form addresses a row in the fleet, so only it becomes a jump.
 */
const isWorkerId = (actor: string): boolean => /^worker_.+/.test(actor);

/** Workers owns `#/workers/:id`; this view is a way in, not a second router. */
const openWorker = (workerId: string) => {
  window.location.hash = `#/${hashPath("workers", workerId)}`;
};

/**
 * Who did this — the lease owner of an attempt, or the actor on a lifecycle
 * row. A worker id is a process you can go look at; an operator or a planner
 * is not, and pretending otherwise would be a link to nowhere.
 */
function ActorRef({ actor, className }: { actor: string; className?: string }) {
  if (!isWorkerId(actor)) return <>{actor}</>;
  return (
    <JumpLink
      onClick={() => openWorker(actor)}
      title={`Which process was this? Open ${actor} in Workers`}
      className={className}
    >
      {actor}
    </JumpLink>
  );
}

/** Runs (webui spec §4.3): state tabs, lifecycle timeline, guarded verbs. */
export function Runs({
  connected,
  focusRunId,
  onSelectRun,
  focusState,
  onFocusStateConsumed,
  onJumpAgent,
  onJumpEvent,
}: {
  connected: boolean;
  focusRunId: string | null;
  onSelectRun: (runId: string | null) => void;
  focusState: string | null;
  onFocusStateConsumed: () => void;
  onJumpAgent: (ref: string) => void;
  onJumpEvent: (source: string, eventId: string) => void;
}) {
  const now = useNow();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<(typeof STATE_TABS)[number]>("ALL");
  const [filter, setFilter] = useState("");
  const [confirm, setConfirm] = useState<"cancel" | "force-retry" | null>(null);
  const [cancelReason, setCancelReason] = useState("");

  const list = useQuery({
    queryKey: ["runs", tab],
    queryFn: () => api.runs(tab === "ALL" ? undefined : tab),
    refetchInterval: 2000,
  });
  const statusQ = useQuery({ queryKey: ["status"], queryFn: api.status, refetchInterval: 2000 });
  const rows = list.data?.runs ?? [];
  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) =>
      [r.runId, r.state, r.agent, r.adapter, r.reasonCode, r.eventId].some((v) =>
        (v ?? "").toLowerCase().includes(q),
      ),
    );
  }, [rows, filter]);

  const selectedId = focusRunId;
  const selectedIndex = useMemo(() => visible.findIndex((r) => r.runId === selectedId), [visible, selectedId]);

  // Deep link / jump: switch to ALL if the run isn't on this tab. Hash stays put.
  // Reveal (clear filter) once per focus id, after the run is in `rows` so a
  // late arrival still surfaces. Typing a filter does not re-reveal.
  const revealedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!focusRunId) {
      revealedFor.current = null;
      return;
    }
    if (rows.some((r) => r.runId === focusRunId)) {
      if (revealedFor.current !== focusRunId) {
        revealedFor.current = focusRunId;
        if (!visible.some((r) => r.runId === focusRunId)) setFilter("");
      }
      return;
    }
    if (tab !== "ALL") setTab("ALL");
  }, [focusRunId, rows, tab, visible]);

  useEffect(() => {
    if (focusState && (STATE_TABS as readonly string[]).includes(focusState)) {
      setTab(focusState as (typeof STATE_TABS)[number]);
      onFocusStateConsumed();
    } else if (focusState) {
      onFocusStateConsumed();
    }
  }, [focusState, onFocusStateConsumed]);

  const sel = selectedIndex >= 0 ? visible[selectedIndex] : null;

  useEffect(() => {
    document.querySelector("tr.row-selected")?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  const detail = useQuery({
    queryKey: ["run", selectedId],
    queryFn: () => api.run(selectedId as string),
    enabled: selectedId !== null,
    refetchInterval: 2000,
  });

  const invalidate = () => queryClient.invalidateQueries();

  const cancel = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason?: string }) => api.cancel(id, reason),
    onSuccess: (_, { id }) => {
      invalidate();
      notify(`Cancelled run ${id}`, "info");
      setConfirm(null);
      setCancelReason("");
    },
    onError: invalidate,
  });

  const retry = useMutation({
    mutationFn: ({ id, force }: { id: string; force: boolean }) => api.retry(id, force),
    onSuccess: (_, { id, force }) => {
      invalidate();
      notify(`${force ? "Force retried" : "Retried"} run ${id}`, "ok");
      setConfirm(null);
    },
    onError: (err) => {
      invalidate();
      // attempts_exhausted → offer the explicit, recorded override (spec §4.3)
      if (err instanceof ApiError && err.message === "attempts_exhausted") setConfirm("force-retry");
    },
  });

  const selectTab = (t: (typeof STATE_TABS)[number]) => {
    setTab(t);
    if (selectedId) onSelectRun(null);
  };
  useTabKeys(STATE_TABS, tab, selectTab);

  useListKeys({
    count: visible.length,
    selected: selectedIndex,
    onSelect: (i) => onSelectRun(visible[i]?.runId ?? null),
    onClose: () => {
      if (selectedId) onSelectRun(null);
      else if (filter) setFilter("");
    },
    keys: {
      // §5 convention: `x` is the destructive verb on the selection — here, cancel.
      x: () => sel && connected && !TERMINAL.includes(sel.state) && setConfirm("cancel"),
      c: () => sel && copyText(sel.runId, "run id"),
    },
  });

  const d = detail.data;
  const attemptsExhausted = d ? d.run.attempts >= d.run.spec.maxAttempts : false;

  // Offer the selection's verbs in the ⌘K palette (§5).
  useEffect(() => {
    if (!sel) {
      setContextActions([]);
    } else {
      const copy = [
        { label: `Copy ${sel.runId}`, hint: "c", run: () => copyText(sel.runId, "run id") },
        { label: "Copy link to this run", run: copyLink },
      ];
      if (!d || !connected) {
        setContextActions(copy);
      } else {
        setContextActions([
          ...(!TERMINAL.includes(d.run.state)
            ? [{ label: `Cancel ${d.run.runId}…`, hint: "x", run: () => setConfirm("cancel") }]
            : []),
          ...(d.run.state === "FAILED"
            ? [
                attemptsExhausted
                  ? { label: `Force retry ${d.run.runId}…`, run: () => setConfirm("force-retry") }
                  : { label: `Retry ${d.run.runId}`, run: () => retry.mutate({ id: d.run.runId, force: false }) },
              ]
            : []),
          ...copy,
        ]);
      }
    }
    return () => setContextActions([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel?.runId, d?.run.runId, d?.run.state, attemptsExhausted, connected]);

  return (
    <div className="flex h-full min-w-0">
      <ListPane
        chrome={
          <>
        <h1 className="display mb-4 text-lg font-semibold">Runs</h1>

        <div className="mb-3 flex items-center gap-2">
          <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto" role="tablist" aria-label="Run state">
            {STATE_TABS.map((t) => {
              const byState = statusQ.data?.runs.byState ?? {};
              const count =
                t === "ALL"
                  ? Object.values(byState).reduce((n, v) => n + (v ?? 0), 0)
                  : (byState[t] ?? 0);
              return (
                <button
                  key={t}
                  type="button"
                  role="tab"
                  aria-selected={tab === t}
                  onClick={() => selectTab(t)}
                  className={`shrink-0 rounded-md px-2.5 py-1 text-[12px] font-medium ${
                    tab === t ? "bg-(--surface-3) text-(--text)" : "text-(--text-faint) hover:bg-(--surface-1)"
                  }`}
                >
                  {t === "ALL" ? "All" : t}
                  {count > 0 && <span className="ml-1.5 tabular-nums text-(--text-faint)">{count}</span>}
                </button>
              );
            })}
          </div>
          <FilterInput
            value={filter}
            onChange={setFilter}
            placeholder="Filter agent, id, origin…"
            label="Filter runs"
          />
        </div>
          </>
        }
      >

        <table className="w-full border-separate border-spacing-0">
          <thead>
            <tr className="text-left text-[11px] text-(--text-faint)">
              <th className="sticky top-0 z-10 bg-(--surface-0) border-b border-(--border) px-3 py-1.5 font-medium">Run</th>
              <th className="sticky top-0 z-10 bg-(--surface-0) border-b border-(--border) px-3 py-1.5 font-medium">State</th>
              <th className="sticky top-0 z-10 bg-(--surface-0) border-b border-(--border) px-3 py-1.5 font-medium">Agent</th>
              <th className="sticky top-0 z-10 bg-(--surface-0) border-b border-(--border) px-3 py-1.5 font-medium">Adapter</th>
              <th className="sticky top-0 z-10 bg-(--surface-0) border-b border-(--border) px-3 py-1.5 font-medium">Attempts</th>
              <th className="sticky top-0 z-10 bg-(--surface-0) border-b border-(--border) px-3 py-1.5 font-medium">Reason</th>
              <th className="sticky top-0 z-10 bg-(--surface-0) border-b border-(--border) px-3 py-1.5 font-medium">Origin</th>
              <th className="sticky top-0 z-10 bg-(--surface-0) border-b border-(--border) px-3 py-1.5 font-medium">Updated</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((r, i) => (
              <tr
                key={r.runId}
                onClick={() => onSelectRun(r.runId)}
                aria-selected={i === selectedIndex}
                className={`cursor-pointer hover:bg-(--surface-1) ${rowWash(r.state)} ${i === selectedIndex ? "row-selected" : ""}`}
              >
                <td className="mono max-w-52 truncate border-b border-(--border) px-3 py-1.5">{r.runId}</td>
                <td className="border-b border-(--border) px-3 py-1.5">
                  <StateBadge state={r.state} />
                </td>
                <td className="border-b border-(--border) px-3 py-1.5 text-(--text-dim)">
                  <JumpLink
                    onClick={() => onJumpAgent(r.agent)}
                    title={`What is ${r.agent}? Open in Agents`}
                  >
                    {r.agent}
                  </JumpLink>
                </td>
                <td className="border-b border-(--border) px-3 py-1.5 text-(--text-faint)">{r.adapter}</td>
                <td className="border-b border-(--border) px-3 py-1.5 tabular-nums text-(--text-dim)">
                  {r.attempts}/{r.maxAttempts}
                </td>
                <td className="mono max-w-36 truncate border-b border-(--border) px-3 py-1.5 text-(--text-faint)">
                  {r.reasonCode ?? "-"}
                </td>
                <td className="mono max-w-40 truncate border-b border-(--border) px-3 py-1.5 text-(--text-faint)">
                  {r.eventId && r.eventSource ? (
                    <JumpLink onClick={() => onJumpEvent(r.eventSource!, r.eventId!)} title="Open origin event">
                      {r.eventId}
                    </JumpLink>
                  ) : (
                    (r.eventId ?? "-")
                  )}
                </td>
                <td className="border-b border-(--border) px-3 py-1.5 text-(--text-faint)">
                  <Ago iso={r.updated_at} now={now} />
                </td>
              </tr>
            ))}
            {visible.length === 0 && (
              <ListEmpty
                colSpan={8}
                query={list}
                filtered={rows.length > 0}
                noun="runs"
                empty={tab === "ALL" ? "No runs." : `No runs in ${tab}.`}
              />
            )}
          </tbody>
        </table>
      </ListPane>

      {sel && (
        <DetailPane
          widthClass="w-[460px]"
          title={
            <span className="flex min-w-0 items-center gap-2">
              <StateBadge state={sel.state} />
              <span className="mono truncate" title={sel.runId}>
                {sel.runId}
              </span>
            </span>
          }
          actions={
            <>
              <Button onClick={() => copyText(sel.runId, "run id")}>Copy id</Button>
              <Button onClick={copyLink}>Copy link</Button>
              <Button onClick={() => onSelectRun(null)}>Close</Button>
            </>
          }
        >

          {!d && (
            <div className="text-(--text-faint)">{detail.isError ? "Could not load run detail." : "Loading run…"}</div>
          )}

          {d && (
            <>
          <Section title="Run">
            <KV k="run" v={d.run.runId} />
            <KV
              k="agent"
              v={
                <JumpLink
                  onClick={() => onJumpAgent(d.run.spec.agent)}
                  title={`What is ${d.run.spec.agent}? Open in Agents`}
                >
                  {d.run.spec.agent}
                </JumpLink>
              }
            />
            <KV k="adapter" v={d.run.spec.adapter} />
            <KV k="attempts" v={`${d.run.attempts}/${d.run.spec.maxAttempts}`} />
            {sel.eventId && (
              <KV
                k="origin event"
                v={
                  sel.eventSource ? (
                    <JumpLink
                      onClick={() => onJumpEvent(sel.eventSource!, sel.eventId!)}
                      title="Open origin event"
                    >
                      {`${sel.eventSource} · ${sel.eventId}`}
                    </JumpLink>
                  ) : (
                    `${sel.eventSource ?? "?"} · ${sel.eventId}`
                  )
                }
              />
            )}
            <KV k="idempotencyKey" v={d.run.idempotencyKey} />
            <KV k="specHash" v={d.run.specHash} />
            <KV k="workspace" v={d.workspace} />
            <KV k="created" v={<Ago iso={d.run.created_at} now={now} />} />
            <KV k="updated" v={<Ago iso={d.run.updated_at} now={now} />} />
            <Disclosure label="immutable RunSpec" defaultOpen>
              <JsonBlock value={d.run.spec} />
            </Disclosure>
          </Section>

          <div className="mb-4 flex gap-2">
            {!TERMINAL.includes(d.run.state) && (
              <Button variant="danger" disabled={!connected} onClick={() => setConfirm("cancel")}>
                Cancel <span className="mono ml-1 opacity-70">x</span>
              </Button>
            )}
            {/* §8: only FAILED → QUEUED is a legal retry transition. */}
            {d.run.state === "FAILED" &&
              (attemptsExhausted ? (
                <Button disabled={!connected} onClick={() => setConfirm("force-retry")}>
                  Force retry…
                </Button>
              ) : (
                <Button
                  disabled={!connected || retry.isPending}
                  onClick={() => retry.mutate({ id: d.run.runId, force: false })}
                >
                  Retry
                </Button>
              ))}
          </div>
          <VerbError error={cancel.error ?? (confirm === "force-retry" ? null : retry.error)} />

          <Section title="Lifecycle">
            <div className="rounded-md border border-(--border) px-3 py-1">
              {d.lifecycle.map((e) => (
                <div key={e.seq} className="flex items-baseline gap-2 border-b border-(--border) py-1.5 last:border-0">
                  <span className="mono w-[64px] shrink-0 text-(--text-faint)" title={e.at}>
                    {new Date(e.at).toLocaleTimeString([], { hour12: false })}
                  </span>
                  <span className="shrink-0">
                    {e.from_state ?? "·"} → <StateBadge state={e.to_state} />
                  </span>
                  <span className="truncate text-(--text-faint)">
                    {/* `.mono` is unlayered author CSS at 11.5px; a utility
                        `text-[13px]` loses the cascade. The important modifier
                        is what actually matches the 13px prose beside it. */}
                    <ActorRef actor={e.actor} className="text-[13px]!" />
                    {e.reason ? ` · ${e.reason}` : ""}
                  </span>
                </div>
              ))}
            </div>
          </Section>

          {d.attempts.length > 0 && (
            <Section title="Attempts">
              {d.attempts.map((a) => (
                <div key={a.attempt} className="mb-1 rounded-md border border-(--border) px-3 py-1.5">
                  <div className="flex justify-between">
                    <span>#{a.attempt}</span>
                    <span className="text-(--text-dim)">{a.terminal_state ?? "in flight"}</span>
                  </div>
                  <div className="mono truncate text-[11px] text-(--text-faint)">
                    {a.reason_code ?? ""} {a.workspace_path ?? ""}
                  </div>
                  <div className="flex items-baseline gap-1.5 truncate text-[11px] text-(--text-faint)">
                    <span>owner</span>
                    {a.lease_owner ? <ActorRef actor={a.lease_owner} /> : <span className="mono">unclaimed</span>}
                  </div>
                  {(a.started_at || a.finished_at) && (
                    <div className="mt-1 flex gap-3 text-[11px] text-(--text-faint)">
                      {a.started_at && (
                        <span>
                          started <Ago iso={a.started_at} now={now} />
                        </span>
                      )}
                      {a.finished_at && (
                        <span>
                          finished <Ago iso={a.finished_at} now={now} />
                        </span>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </Section>
          )}

          {d.result && (
            <Section title={`Result · ${d.result.terminalState}${d.result.reasonCode ? ` · ${d.result.reasonCode}` : ""}`}>
              {d.result.artifact !== undefined ? (
                <Disclosure label="artifact" defaultOpen>
                  <JsonBlock value={d.result.artifact} />
                </Disclosure>
              ) : (
                <Disclosure label="result" defaultOpen>
                  <JsonBlock value={d.result} />
                </Disclosure>
              )}
              {d.result.evidence !== undefined && (
                <Disclosure label="evidence — what the agent claims it verified">
                  <JsonBlock value={d.result.evidence} />
                </Disclosure>
              )}
            </Section>
          )}

          {d.result && (
            <Section title="Artifacts">
              {(d.result.artifacts ?? []).length === 0 ? (
                <div className="text-(--text-faint)">No stored artifacts.</div>
              ) : (
                <div className="rounded-md border border-(--border) px-3 py-1">
                  {(d.result.artifacts ?? []).map((a) => (
                    <div
                      key={a.sha256}
                      className="flex items-baseline justify-between gap-3 border-b border-(--border) py-1.5 last:border-0"
                    >
                      <span className="truncate">
                        {a.kind}
                        <span className="mono ml-2 text-[11px] text-(--text-faint)" title={a.sha256}>
                          {a.sha256.slice(0, 12)}
                        </span>
                      </span>
                      <span className="flex shrink-0 items-baseline gap-3">
                        <span className="tabular-nums text-(--text-faint)">{humanSize(a.sizeBytes)}</span>
                        <a
                          href={artifactUrl(a.sha256)}
                          target="_blank"
                          rel="noreferrer"
                          className="text-(--accent) hover:underline"
                        >
                          Open
                        </a>
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </Section>
          )}

          {d.receipt && (
            <Section title="Receipt">
              {Object.entries(d.receipt).map(([k, v]) => (
                <KV key={k} k={k} v={v} />
              ))}
            </Section>
          )}
            </>
          )}
        </DetailPane>
      )}

      {confirm === "cancel" && d && (
        <Dialog title={`Cancel ${d.run.runId}?`} onClose={() => setConfirm(null)}>
          <div className="mb-3 text-[12px] text-(--text-dim)">
            {d.run.state === "RUNNING"
              ? "The running attempt is stopped with TERM, then KILL, and terminates as cancelled."
              : "The run is cancelled before execution; the operator is recorded as actor."}
          </div>
          <input
            value={cancelReason}
            onChange={(e) => setCancelReason(e.target.value)}
            placeholder="Reason (optional)"
            className="mb-3 w-full rounded-md border border-(--border-strong) bg-(--surface-0) px-2.5 py-1.5 text-(--text) outline-none focus:border-(--accent)"
          />
          <div className="flex justify-end gap-2">
            <Button onClick={() => setConfirm(null)}>Keep run</Button>
            <Button
              variant="danger"
              disabled={cancel.isPending}
              onClick={() => cancel.mutate({ id: d.run.runId, reason: cancelReason.trim() || undefined })}
            >
              Cancel run
            </Button>
          </div>
        </Dialog>
      )}

      {confirm === "force-retry" && d && (
        <Dialog title="Retry past the attempt budget?" onClose={() => setConfirm(null)}>
          <div className="mb-3 text-[12px] text-(--text-dim)">
            This run has used {d.run.attempts}/{d.run.spec.maxAttempts} attempts. Forcing a retry
            overrides the declared budget and is recorded in the audit trail as an explicit operator
            override.
          </div>
          <VerbError error={retry.error} />
          <div className="mt-3 flex justify-end gap-2">
            <Button onClick={() => setConfirm(null)}>Leave it</Button>
            <Button
              variant="primary"
              disabled={retry.isPending}
              onClick={() => retry.mutate({ id: d.run.runId, force: true })}
            >
              Force retry
            </Button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
