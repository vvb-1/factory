import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../api";
import { useListKeys, useNow } from "../hooks";
import { setContextActions } from "../palette";
import type { RunState } from "../types";
import { ago, Button, Dialog, Disclosure, JsonBlock, KV, Section, StateBadge, VerbError } from "../components/ui";

const STATE_TABS: (RunState | "ALL")[] = [
  "ALL", "QUEUED", "RUNNING", "COMPLETED", "REFUSED", "FAILED", "TIMED_OUT", "CANCELLED",
];
const TERMINAL: RunState[] = ["COMPLETED", "REFUSED", "FAILED", "TIMED_OUT", "CANCELLED"];

/** Runs (webui spec §4.3): state tabs, lifecycle timeline, guarded verbs. */
export function Runs({
  connected,
  focusRunId,
  onFocusConsumed,
}: {
  connected: boolean;
  focusRunId: string | null;
  onFocusConsumed: () => void;
}) {
  const now = useNow();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<(typeof STATE_TABS)[number]>("ALL");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"cancel" | "force-retry" | null>(null);
  const [cancelReason, setCancelReason] = useState("");

  const list = useQuery({
    queryKey: ["runs", tab],
    queryFn: () => api.runs(tab === "ALL" ? undefined : tab),
    refetchInterval: 2000,
  });
  const rows = list.data?.runs ?? [];

  // Deep link from an approval: select the queued run once, then release.
  useEffect(() => {
    if (focusRunId && rows.some((r) => r.runId === focusRunId)) {
      setSelectedId(focusRunId);
      onFocusConsumed();
    }
  }, [focusRunId, rows, onFocusConsumed]);

  const selectedIndex = useMemo(() => rows.findIndex((r) => r.runId === selectedId), [rows, selectedId]);
  const sel = selectedIndex >= 0 ? rows[selectedIndex] : null;

  const detail = useQuery({
    queryKey: ["run", selectedId],
    queryFn: () => api.run(selectedId as string),
    enabled: selectedId !== null,
    refetchInterval: 2000,
  });

  const invalidate = () => queryClient.invalidateQueries();

  const cancel = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason?: string }) => api.cancel(id, reason),
    onSuccess: () => {
      invalidate();
      setConfirm(null);
      setCancelReason("");
    },
    onError: invalidate,
  });

  const retry = useMutation({
    mutationFn: ({ id, force }: { id: string; force: boolean }) => api.retry(id, force),
    onSuccess: () => {
      invalidate();
      setConfirm(null);
    },
    onError: (err) => {
      invalidate();
      // attempts_exhausted → offer the explicit, recorded override (spec §4.3)
      if (err instanceof ApiError && err.message === "attempts_exhausted") setConfirm("force-retry");
    },
  });

  useListKeys({
    count: rows.length,
    selected: selectedIndex,
    onSelect: (i) => setSelectedId(rows[i]?.runId ?? null),
    onClose: () => setSelectedId(null),
    keys: {
      // §5 convention: `x` is the destructive verb on the selection — here, cancel.
      x: () => sel && connected && !TERMINAL.includes(sel.state) && setConfirm("cancel"),
    },
  });

  const d = detail.data;
  const attemptsExhausted = d ? d.run.attempts >= d.run.spec.maxAttempts : false;

  // Offer the selection's verbs in the ⌘K palette (§5).
  useEffect(() => {
    if (!d || !connected) {
      setContextActions([]);
    } else {
      setContextActions([
        ...(!TERMINAL.includes(d.run.state)
          ? [{ label: `Cancel ${d.run.runId}…`, run: () => setConfirm("cancel") }]
          : []),
        ...(d.run.state === "FAILED"
          ? [
              attemptsExhausted
                ? { label: `Force retry ${d.run.runId}…`, run: () => setConfirm("force-retry") }
                : { label: `Retry ${d.run.runId}`, run: () => retry.mutate({ id: d.run.runId, force: false }) },
            ]
          : []),
      ]);
    }
    return () => setContextActions([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d?.run.runId, d?.run.state, attemptsExhausted, connected]);

  return (
    <div className="flex h-full min-w-0">
      <div className="min-w-0 flex-1 overflow-auto p-5">
        <h1 className="display mb-4 text-lg font-semibold">Runs</h1>

        <div className="mb-3 flex gap-1">
          {STATE_TABS.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`rounded-md px-2.5 py-1 text-[12px] font-medium ${
                tab === t ? "bg-(--surface-3) text-(--text)" : "text-(--text-faint) hover:bg-(--surface-1)"
              }`}
            >
              {t === "ALL" ? "All" : t}
            </button>
          ))}
        </div>

        <table className="w-full border-separate border-spacing-0">
          <thead>
            <tr className="text-left text-[11px] text-(--text-faint)">
              <th className="border-b border-(--border) px-3 py-1.5 font-medium">Run</th>
              <th className="border-b border-(--border) px-3 py-1.5 font-medium">State</th>
              <th className="border-b border-(--border) px-3 py-1.5 font-medium">Agent</th>
              <th className="border-b border-(--border) px-3 py-1.5 font-medium">Adapter</th>
              <th className="border-b border-(--border) px-3 py-1.5 font-medium">Attempts</th>
              <th className="border-b border-(--border) px-3 py-1.5 font-medium">Reason</th>
              <th className="border-b border-(--border) px-3 py-1.5 font-medium">Origin</th>
              <th className="border-b border-(--border) px-3 py-1.5 font-medium">Updated</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr
                key={r.runId}
                onClick={() => setSelectedId(r.runId)}
                className={`cursor-pointer hover:bg-(--surface-1) ${i === selectedIndex ? "row-selected" : ""}`}
              >
                <td className="mono max-w-52 truncate border-b border-(--border) px-3 py-1.5">{r.runId}</td>
                <td className="border-b border-(--border) px-3 py-1.5">
                  <StateBadge state={r.state} />
                </td>
                <td className="border-b border-(--border) px-3 py-1.5 text-(--text-dim)">{r.agent}</td>
                <td className="border-b border-(--border) px-3 py-1.5 text-(--text-faint)">{r.adapter}</td>
                <td className="border-b border-(--border) px-3 py-1.5 tabular-nums text-(--text-dim)">
                  {r.attempts}/{r.maxAttempts}
                </td>
                <td className="mono max-w-36 truncate border-b border-(--border) px-3 py-1.5 text-(--text-faint)">
                  {r.reasonCode ?? "-"}
                </td>
                <td className="mono max-w-40 truncate border-b border-(--border) px-3 py-1.5 text-(--text-faint)">
                  {r.eventId ?? "-"}
                </td>
                <td className="border-b border-(--border) px-3 py-1.5 text-(--text-faint)">{ago(r.updated_at, now)}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={8} className="px-3 py-8 text-center text-(--text-faint)">
                  No runs{tab === "ALL" ? "" : ` in ${tab}`}.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {sel && d && (
        <div className="w-[460px] shrink-0 overflow-auto border-l border-(--border) bg-(--surface-1) p-4">
          <div className="mb-3 flex items-center justify-between gap-2">
            <StateBadge state={d.run.state} />
            <Button onClick={() => setSelectedId(null)}>Close</Button>
          </div>

          <Section title="Run">
            <KV k="run" v={d.run.runId} />
            <KV k="agent" v={d.run.spec.agent} />
            <KV k="adapter" v={d.run.spec.adapter} />
            <KV k="attempts" v={`${d.run.attempts}/${d.run.spec.maxAttempts}`} />
            {sel.eventId && <KV k="origin event" v={`${sel.eventSource ?? "?"} · ${sel.eventId}`} />}
            <KV k="idempotencyKey" v={d.run.idempotencyKey} />
            <KV k="specHash" v={d.run.specHash} />
            <KV k="workspace" v={d.workspace} />
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
                  <span className="mono w-[64px] shrink-0 text-(--text-faint)">
                    {new Date(e.at).toLocaleTimeString([], { hour12: false })}
                  </span>
                  <span className="shrink-0">
                    <StateBadge state={e.to_state} />
                  </span>
                  <span className="truncate text-(--text-faint)">
                    {e.actor}
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

          {d.receipt && (
            <Section title="Receipt">
              {Object.entries(d.receipt).map(([k, v]) => (
                <KV key={k} k={k} v={v} />
              ))}
            </Section>
          )}

          <Section title="Spec">
            <JsonBlock value={d.run.spec} />
          </Section>
        </div>
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
