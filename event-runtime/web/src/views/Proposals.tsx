import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { useListKeys, useNow } from "../hooks";
import { setContextActions } from "../palette";
import type { Proposal } from "../types";
import { SpecDiff } from "../components/SpecDiff";
import { ago, Button, Countdown, Dialog, JsonBlock, KV, Section, VerbError } from "../components/ui";

/**
 * Proposals (webui spec §4.2) — the watched-approval centerpiece. The full
 * immutable RunSpec is always rendered (§12: the operator approves a spec,
 * not a summary), and a TTL-expired approval that re-plans STOPS and shows
 * the diff — never auto-approves the replacement.
 */
export function Proposals({
  connected,
  onRunQueued,
  focusProposalId,
  onFocusConsumed,
}: {
  connected: boolean;
  onRunQueued: (runId: string) => void;
  focusProposalId: string | null;
  onFocusConsumed: () => void;
}) {
  const now = useNow();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["proposals"],
    queryFn: api.proposals,
    refetchInterval: 2000,
  });
  const rows = query.data?.proposals ?? [];

  // An open proposal's run should still be PROPOSED; anything else means it
  // was raced (e.g. cancelled from the Runs view) and can never be approved.
  const runsQuery = useQuery({ queryKey: ["runs", "ALL"], queryFn: () => api.runs(), refetchInterval: 2000 });
  const runStates = useMemo(
    () => new Map((runsQuery.data?.runs ?? []).map((r) => [r.runId, r.state])),
    [runsQuery.data],
  );
  const staleState = (p: Proposal) => {
    const state = p.runId ? runStates.get(p.runId) : undefined;
    return state && state !== "PROPOSED" ? state : null;
  };

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [confirmApprove, setConfirmApprove] = useState(false);
  const [reason, setReason] = useState("");
  const [replan, setReplan] = useState<{ before: Proposal; after: Proposal } | null>(null);
  const reasonRef = useRef<HTMLInputElement>(null);

  const selectedIndex = useMemo(() => rows.findIndex((p) => p.id === selectedId), [rows, selectedId]);
  const sel = selectedIndex >= 0 ? rows[selectedIndex] : null;

  // Deep link from the ⌘K palette.
  useEffect(() => {
    if (focusProposalId && rows.some((p) => p.id === focusProposalId)) {
      setSelectedId(focusProposalId);
      onFocusConsumed();
    }
  }, [focusProposalId, rows, onFocusConsumed]);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["proposals"] });
    queryClient.invalidateQueries({ queryKey: ["status"] });
    queryClient.invalidateQueries({ queryKey: ["runs"] });
  };

  const approve = useMutation({
    mutationFn: (p: Proposal) => api.approve(p.id).then((outcome) => ({ p, outcome })),
    onSuccess: ({ p, outcome }) => {
      invalidate();
      if (outcome.approved && outcome.runId) {
        onRunQueued(outcome.runId);
      } else if (outcome.replanned && outcome.proposal) {
        // §12: expired proposal re-planned to a different spec — stop and show it.
        setReplan({ before: p, after: outcome.proposal });
        setSelectedId(outcome.proposal.id);
      }
    },
    onError: invalidate, // 404/409 mean someone else acted — converge on truth
  });

  const reject = useMutation({
    mutationFn: ({ id, why }: { id: string; why: string }) => api.reject(id, why),
    onSuccess: () => {
      invalidate();
      setRejecting(false);
      setReason("");
    },
    onError: invalidate,
  });

  const canApprove = sel !== null && sel.decision === "run" && !staleState(sel);
  const openReject = () => {
    setRejecting(true);
    setTimeout(() => reasonRef.current?.focus(), 0);
  };

  useListKeys({
    count: rows.length,
    selected: selectedIndex,
    onSelect: (i) => setSelectedId(rows[i]?.id ?? null),
    onClose: () => setSelectedId(null),
    keys: {
      // §5: `a` opens the confirm with the spec in view — it never fires the verb directly.
      a: () => canApprove && connected && setConfirmApprove(true),
      x: () => sel && connected && openReject(),
    },
  });

  // Offer the selection's verbs in the ⌘K palette (§5).
  useEffect(() => {
    if (!sel || !connected) {
      setContextActions([]);
    } else {
      setContextActions([
        ...(canApprove
          ? [{ label: `Approve ${sel.agent ?? sel.id}…`, hint: "a", run: () => setConfirmApprove(true) }]
          : []),
        { label: `Reject ${sel.agent ?? sel.id}…`, hint: "x", run: openReject },
      ]);
    }
    return () => setContextActions([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel?.id, canApprove, connected]);

  return (
    <div className="flex h-full min-w-0">
      <div className="min-w-0 flex-1 overflow-auto p-5">
        <h1 className="display mb-4 text-lg font-semibold">Proposals</h1>
        <table className="w-full border-separate border-spacing-0">
          <thead>
            <tr className="text-left text-[11px] text-(--text-faint)">
              <th className="border-b border-(--border) px-3 py-1.5 font-medium">Agent</th>
              <th className="border-b border-(--border) px-3 py-1.5 font-medium">Decision</th>
              <th className="border-b border-(--border) px-3 py-1.5 font-medium">TTL</th>
              <th className="border-b border-(--border) px-3 py-1.5 font-medium">Created</th>
              <th className="border-b border-(--border) px-3 py-1.5 font-medium">Reason</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p, i) => (
              <tr
                key={p.id}
                onClick={() => setSelectedId(p.id)}
                className={`cursor-pointer hover:bg-(--surface-1) ${i === selectedIndex ? "row-selected" : ""}`}
              >
                <td className="border-b border-(--border) px-3 py-1.5">{p.agent ?? "—"}</td>
                <td className="border-b border-(--border) px-3 py-1.5">
                  <span style={{ color: p.decision === "run" ? "var(--hue-info)" : "var(--hue-warn)" }}>
                    {p.decision}
                  </span>
                  {p.expired && (
                    <span className="ml-2" style={{ color: "var(--hue-warn)" }}>
                      expired
                    </span>
                  )}
                  {staleState(p) && (
                    <span className="ml-2" style={{ color: "var(--hue-err)" }}>
                      run {staleState(p)}
                    </span>
                  )}
                </td>
                <td className="border-b border-(--border) px-3 py-1.5">
                  <Countdown createdAt={p.created_at} ttlSeconds={p.ttl_seconds} />
                </td>
                <td className="border-b border-(--border) px-3 py-1.5 text-(--text-faint)">{ago(p.created_at, now)}</td>
                <td className="max-w-64 truncate border-b border-(--border) px-3 py-1.5 text-(--text-dim)">{p.reason ?? "-"}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-8 text-center text-(--text-faint)">
                  No open proposals — the operator&apos;s work is done, for now.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {sel && (
        <div className="w-[460px] shrink-0 overflow-auto border-l border-(--border) bg-(--surface-1) p-4">
          <div className="mb-3 flex items-center justify-between">
            <div className="display truncate text-[14px] font-semibold" title={sel.id}>
              {sel.agent ?? sel.id}
            </div>
            <Button onClick={() => setSelectedId(null)}>Close</Button>
          </div>

          <Section title="Proposal">
            <KV k="id" v={sel.id} />
            <KV k="decision" v={sel.decision} />
            <KV k="run" v={sel.runId} />
            <KV
              k="ttl"
              v={<Countdown createdAt={sel.created_at} ttlSeconds={sel.ttl_seconds} />}
            />
            {sel.reason && <KV k="planner reason" v={sel.reason} />}
          </Section>

          {sel.spec && (
            <Section title="Run spec — what you approve">
              <JsonBlock value={sel.spec} />
            </Section>
          )}

          {staleState(sel) && (
            <div
              className="mb-3 rounded-md px-2.5 py-1.5 text-[12px]"
              style={{
                color: "var(--hue-err)",
                background: "color-mix(in oklch, var(--hue-err) 10%, transparent)",
              }}
            >
              This proposal&apos;s run is already {staleState(sel)} — it can no longer be approved.
              Reject it to clear the queue.
            </div>
          )}
          <div className="flex gap-2">
            {canApprove && (
              <Button
                variant="primary"
                disabled={!connected || approve.isPending}
                onClick={() => setConfirmApprove(true)}
              >
                Approve… <span className="mono ml-1 opacity-70">a</span>
              </Button>
            )}
            <Button variant="danger" disabled={!connected || reject.isPending} onClick={openReject}>
              Reject <span className="mono ml-1 opacity-70">x</span>
            </Button>
          </div>

          {rejecting && (
            <div className="mt-3 flex gap-2">
              <input
                ref={reasonRef}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && reason.trim()) reject.mutate({ id: sel.id, why: reason.trim() });
                  if (e.key === "Escape") setRejecting(false);
                }}
                placeholder="Reason (required — rejections are audit records)"
                className="flex-1 rounded-md border border-(--border-strong) bg-(--surface-0) px-2.5 py-1 text-(--text) outline-none focus:border-(--accent)"
              />
              <Button
                variant="danger"
                disabled={!reason.trim() || reject.isPending}
                onClick={() => reject.mutate({ id: sel.id, why: reason.trim() })}
              >
                Confirm
              </Button>
            </div>
          )}

          <VerbError error={approve.error ?? reject.error} />
        </div>
      )}

      {confirmApprove && sel && (
        <Dialog title="Approve and queue this run?" onClose={() => setConfirmApprove(false)} wide>
          <div className="mb-3 text-[12px] text-(--text-dim)">
            You are approving this exact immutable spec — the agent below runs with these
            capabilities the moment you confirm.
          </div>
          <div className="mb-3">
            <KV k="agent" v={sel.spec?.agent} />
            <KV k="adapter" v={sel.spec?.adapter} />
            <KV k="capabilities" v={sel.spec?.capabilities.join(", ") || "none"} />
            <KV k="timeout" v={`${sel.spec?.timeoutSeconds}s`} />
            <KV k="attempts" v={String(sel.spec?.maxAttempts)} />
            <KV k="ttl" v={<Countdown createdAt={sel.created_at} ttlSeconds={sel.ttl_seconds} />} />
          </div>
          {sel.spec && <JsonBlock value={sel.spec} />}
          <div className="mt-3 flex justify-end gap-2">
            <Button onClick={() => setConfirmApprove(false)}>Not yet</Button>
            <Button
              variant="primary"
              autoFocus
              disabled={!connected || approve.isPending}
              onClick={() => {
                setConfirmApprove(false);
                approve.mutate(sel);
              }}
            >
              Approve and queue
            </Button>
          </div>
        </Dialog>
      )}

      {replan && (
        <Dialog title="Proposal expired — re-planned against current state" onClose={() => setReplan(null)} wide>
          <div className="mb-3 text-[12px] text-(--text-dim)">
            The TTL passed, so the planner re-read authoritative state and produced a new spec. Review
            the difference; nothing runs until you approve the new proposal explicitly.
          </div>
          <SpecDiff before={replan.before.spec} after={replan.after.spec} />
          <div className="mt-3 flex justify-end gap-2">
            <Button onClick={() => setReplan(null)}>Not now</Button>
            <Button
              variant="primary"
              disabled={!connected || approve.isPending}
              onClick={() => {
                const fresh = replan.after;
                setReplan(null);
                approve.mutate(fresh);
              }}
            >
              Approve new proposal
            </Button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
