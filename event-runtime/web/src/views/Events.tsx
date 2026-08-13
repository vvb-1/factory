import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { retriggerEnvelope } from "../templates";
import { useListKeys, useNow } from "../hooks";
import { setContextActions } from "../palette";
import type { AdmittedEvent, EventFocus } from "../types";
import {
  ago,
  Button,
  Dialog,
  Disclosure,
  EVENT_STATUS_HUES,
  FilterInput,
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

const STATUS_TABS = ["all", "admitted", "planned", "noop", "human_needed", "dead_lettered"] as const;
type StatusTab = (typeof STATUS_TABS)[number];

/** Only these two statuses may be requeued (planner.mjs requeueEvent). */
const REQUEUEABLE = new Set(["dead_lettered", "human_needed"]);

const TAB_LABEL: Record<StatusTab, string> = {
  all: "All",
  admitted: "Admitted",
  planned: "Planned",
  noop: "Noop",
  human_needed: "Human needed",
  dead_lettered: "Dead lettered",
};

const keyOf = (e: AdmittedEvent) => `${e.source}:${e.eventId}`;

function isStatusTab(value: string | undefined): value is StatusTab {
  return !!value && (STATUS_TABS as readonly string[]).includes(value);
}

function rowWash(status: string): string {
  if (status === "dead_lettered") return "row-wash-err";
  if (status === "human_needed") return "row-wash-warn";
  return "";
}

/**
 * Events (webui doc §10.1) — the event inbox. Every admitted envelope with
 * its planning outcome; dead letters carry the error tone, and requeue
 * (`q`) re-plans a dead_lettered/human_needed event through the same path
 * as a fresh admission.
 */
export function Events({
  connected,
  focusEvent,
  onFocusConsumed,
  onSelectEvent,
  onSelectType,
  onJumpProposal,
  onJumpRun,
  onTriggerAgain,
  onInject,
}: {
  connected: boolean;
  focusEvent: EventFocus | null;
  onFocusConsumed: () => void;
  onSelectEvent: (source: string | null, eventId?: string) => void;
  onSelectType: (type: string | null) => void;
  onJumpProposal: (id: string) => void;
  onJumpRun: (runId: string) => void;
  onTriggerAgain: (envelope: Record<string, unknown>) => void;
  onInject: () => void;
}) {
  const now = useNow();
  const queryClient = useQueryClient();
  const alive = useRef(true);
  const [tab, setTab] = useState<StatusTab>(isStatusTab(focusEvent?.status) ? focusEvent.status : "all");
  const [filter, setFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState<string | null>(focusEvent?.type ?? null);
  const [sourceFilter, setSourceFilter] = useState<string | null>(null);
  const [confirmReplay, setConfirmReplay] = useState(false);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const list = useQuery({
    queryKey: ["events", tab],
    queryFn: () => api.events(tab === "all" ? undefined : tab),
    refetchInterval: 2000,
  });
  const statusQ = useQuery({ queryKey: ["status"], queryFn: api.status, refetchInterval: 2000 });
  const rows = list.data?.events ?? [];

  const types = useMemo(() => [...new Set(rows.map((e) => e.type))].sort(), [rows]);
  const sources = useMemo(() => [...new Set(rows.map((e) => e.source))].sort(), [rows]);

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return rows.filter((e) => {
      if (typeFilter && e.type !== typeFilter) return false;
      if (sourceFilter && e.source !== sourceFilter) return false;
      if (!q) return true;
      return (
        e.eventId.toLowerCase().includes(q) ||
        e.source.toLowerCase().includes(q) ||
        e.type.toLowerCase().includes(q) ||
        (e.subject ?? "").toLowerCase().includes(q)
      );
    });
  }, [rows, filter, typeFilter, sourceFilter]);

  const selectedKey =
    focusEvent?.source && focusEvent?.eventId ? `${focusEvent.source}:${focusEvent.eventId}` : null;
  const selectedIndex = useMemo(
    () => visible.findIndex((e) => keyOf(e) === selectedKey),
    [visible, selectedKey],
  );
  const sel = selectedIndex >= 0 ? visible[selectedIndex] : null;

  useEffect(() => {
    document.querySelector("tr.row-selected")?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  // Ephemeral Overview/Graph jumps: apply tab/type then drop them so the hash
  // (if any) is the only remaining selection source.
  useEffect(() => {
    if (!focusEvent) return;
    if (isStatusTab(focusEvent.status) && tab !== focusEvent.status) setTab(focusEvent.status);
    if (focusEvent.type) setTypeFilter(focusEvent.type);
    if (focusEvent.status || focusEvent.type) onFocusConsumed();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusEvent?.status, focusEvent?.type]);

  // Hash id: switch to All if the row isn't on this tab. Don't strip the hash.
  useEffect(() => {
    if (!focusEvent?.source || !focusEvent?.eventId) return;
    setFilter("");
    setSourceFilter(null);
    if (!focusEvent.type) setTypeFilter(null);
    const key = `${focusEvent.source}:${focusEvent.eventId}`;
    if (!rows.some((e) => keyOf(e) === key) && tab !== "all") setTab("all");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusEvent?.source, focusEvent?.eventId, rows, tab]);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["events"] });
    queryClient.invalidateQueries({ queryKey: ["status"] });
    queryClient.invalidateQueries({ queryKey: ["proposals"] });
  };

  const requeue = useMutation({
    mutationFn: (e: AdmittedEvent) => api.requeue(e.source, e.eventId),
    onSuccess: async (_, e) => {
      invalidate();
      notify(`Requeued event ${e.eventId}`, "ok");
      const deadline = Date.now() + 8000;
      while (alive.current && Date.now() < deadline) {
        const { proposals } = await api.proposals();
        const match = proposals.find((p) => p.eventSource === e.source && p.eventId === e.eventId);
        if (match && alive.current) {
          onJumpProposal(match.id);
          return;
        }
        await new Promise((r) => setTimeout(r, 250));
      }
    },
    onError: invalidate, // 404/409 mean someone else acted — converge on truth
  });

  const replay = useMutation({
    mutationFn: (envelope: unknown) => api.replay(envelope),
    onSuccess: (data) => {
      queryClient.invalidateQueries();
      setConfirmReplay(false);
      notify(data.duplicate ? `Duplicate event ${data.eventId}` : `Replayed event ${data.eventId}`, "info");
    },
  });

  const canRequeue = sel !== null && REQUEUEABLE.has(sel.status);

  useListKeys({
    count: visible.length,
    selected: selectedIndex,
    onSelect: (i) => {
      const e = visible[i];
      onSelectEvent(e ? e.source : null, e?.eventId);
    },
    onClose: () => {
      if (selectedKey) onSelectEvent(null);
      else if (filter || typeFilter || sourceFilter) {
        setFilter("");
        setTypeFilter(null);
        setSourceFilter(null);
        onSelectType(null);
      }
    },
    keys: {
      // `q` not `r`: `r` is the `g r` navigation suffix, and both listeners
      // see the same keydown — `g r` with a selection must never requeue.
      q: () => canRequeue && connected && sel && requeue.mutate(sel),
      c: () => sel && copyText(sel.eventId, "event id"),
    },
  });

  // Offer the selection's verbs in the ⌘K palette (§5).
  useEffect(() => {
    if (!sel || !connected) {
      setContextActions([]);
    } else {
      setContextActions([
        ...(canRequeue
          ? [{ label: `Requeue ${sel.eventId} (re-plan admitted event)`, hint: "q", run: () => requeue.mutate(sel) }]
          : []),
        { label: `Replay ${sel.eventId} through intake…`, run: () => setConfirmReplay(true) },
        {
          label: `Trigger ${sel.type} again (new event id)…`,
          run: () => onTriggerAgain(retriggerEnvelope(sel.envelope, Date.now())),
        },
        { label: `Copy ${sel.eventId}`, hint: "c", run: () => copyText(sel.eventId, "event id") },
        { label: "Copy link to this event", run: copyLink },
      ]);
    }
    return () => setContextActions([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel ? keyOf(sel) : null, canRequeue, connected]);

  const eventCounts = statusQ.data?.events ?? {};
  const allCount = Object.values(eventCounts).reduce((n, v) => n + v, 0);
  const tabCount = (t: StatusTab) => (t === "all" ? allCount : (eventCounts[t] ?? 0));

  return (
    <div className="flex h-full min-w-0">
      <div className="min-w-0 flex-1 overflow-auto p-5">
        <h1 className="display mb-4 text-lg font-semibold">Events</h1>

        <div className="mb-3 flex flex-wrap gap-1" role="tablist" aria-label="Event status">
          {STATUS_TABS.map((t) => {
            const count = tabCount(t);
            return (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={tab === t}
                onClick={() => setTab(t)}
                className={`rounded-md px-2.5 py-1 text-[12px] font-medium ${
                  tab === t ? "bg-(--surface-3) text-(--text)" : "text-(--text-faint) hover:bg-(--surface-1)"
                }`}
              >
                {TAB_LABEL[t]}
                {count > 0 && <span className="ml-1.5 tabular-nums text-(--text-faint)">{count}</span>}
              </button>
            );
          })}
        </div>

        <div className="mb-3 flex flex-wrap items-center gap-2">
          <FilterInput
            value={filter}
            onChange={setFilter}
            placeholder="Filter type, source, id…"
            label="Filter events"
          />
          {types.length > 1 &&
            types.map((t) => (
              <button
                key={t}
                type="button"
                aria-pressed={typeFilter === t}
                onClick={() => {
                  const next = typeFilter === t ? null : t;
                  setTypeFilter(next);
                  onSelectType(next);
                }}
                className={`rounded-md px-2 py-0.5 text-[11px] ${
                  typeFilter === t
                    ? "bg-(--surface-3) text-(--text)"
                    : "text-(--text-faint) hover:bg-(--surface-1)"
                }`}
              >
                {t}
              </button>
            ))}
          {sources.length > 1 &&
            sources.map((s) => (
              <button
                key={s}
                type="button"
                aria-pressed={sourceFilter === s}
                onClick={() => setSourceFilter((cur) => (cur === s ? null : s))}
                className={`rounded-md px-2 py-0.5 font-mono text-[11px] ${
                  sourceFilter === s
                    ? "bg-(--surface-3) text-(--text)"
                    : "text-(--text-faint) hover:bg-(--surface-1)"
                }`}
              >
                {s}
              </button>
            ))}
        </div>

        <table className="w-full border-separate border-spacing-0">
          <thead>
            <tr className="text-left text-[11px] text-(--text-faint)">
              <th className="sticky top-0 z-10 bg-(--surface-0) border-b border-(--border) px-3 py-1.5 font-medium">Event</th>
              <th className="sticky top-0 z-10 bg-(--surface-0) border-b border-(--border) px-3 py-1.5 font-medium">Source</th>
              <th className="sticky top-0 z-10 bg-(--surface-0) border-b border-(--border) px-3 py-1.5 font-medium">Type</th>
              <th className="sticky top-0 z-10 bg-(--surface-0) border-b border-(--border) px-3 py-1.5 font-medium">Subject</th>
              <th className="sticky top-0 z-10 bg-(--surface-0) border-b border-(--border) px-3 py-1.5 font-medium">Status</th>
              <th className="sticky top-0 z-10 bg-(--surface-0) border-b border-(--border) px-3 py-1.5 font-medium">Admitted</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((e, i) => (
              <tr
                key={keyOf(e)}
                onClick={() => onSelectEvent(e.source, e.eventId)}
                aria-selected={i === selectedIndex}
                className={`cursor-pointer hover:bg-(--surface-1) ${rowWash(e.status)} ${i === selectedIndex ? "row-selected" : ""}`}
              >
                <td className="mono max-w-52 truncate border-b border-(--border) px-3 py-1.5">{e.eventId}</td>
                <td className="mono max-w-28 truncate border-b border-(--border) px-3 py-1.5 text-(--text-faint)">
                  {e.source}
                </td>
                <td className="border-b border-(--border) px-3 py-1.5 text-(--text-dim)">{e.type}</td>
                <td className="max-w-40 truncate border-b border-(--border) px-3 py-1.5 text-(--text-faint)">
                  {e.subject ?? "-"}
                </td>
                <td className="border-b border-(--border) px-3 py-1.5">
                  <StateBadge state={e.status} hues={EVENT_STATUS_HUES} />
                  {e.planFailures > 0 && (
                    <span className="ml-2 text-[11px]" style={{ color: "var(--hue-err)" }}>
                      {e.planFailures} plan failure{e.planFailures === 1 ? "" : "s"}
                    </span>
                  )}
                </td>
                <td className="border-b border-(--border) px-3 py-1.5 text-(--text-faint)">{ago(e.admittedAt, now)}</td>
              </tr>
            ))}
            {visible.length === 0 && (
              <ListEmpty
                colSpan={6}
                query={list}
                filtered={rows.length > 0}
                noun="events"
                empty={
                  tab === "all"
                    ? "No events yet."
                    : `No ${TAB_LABEL[tab].toLowerCase()} events.`
                }
                action={
                  tab === "all" ? (
                    <Button onClick={onInject}>Inject event…</Button>
                  ) : undefined
                }
              />
            )}
          </tbody>
        </table>
      </div>

      {sel && (
        <div className="w-[440px] shrink-0 overflow-auto border-l border-(--border) bg-(--surface-1) p-4">
          <div className="mb-3 flex items-center justify-between gap-2">
            <div className="display truncate text-[14px] font-semibold" title={sel.eventId}>
              {sel.eventId}
            </div>
            <div className="flex shrink-0 gap-1.5">
              <Button onClick={() => copyText(sel.eventId, "event id")}>Copy id</Button>
              <Button onClick={copyLink}>Copy link</Button>
              <Button onClick={() => onSelectEvent(null)}>Close</Button>
            </div>
          </div>

          <Section title="Event">
            <KV k="source" v={sel.source} />
            <KV k="type" v={sel.type} />
            <KV k="subject" v={sel.subject} />
            <KV k="status" v={<StateBadge state={sel.status} hues={EVENT_STATUS_HUES} />} />
            <KV k="correlationId" v={sel.correlationId} />
            <KV k="occurredAt" v={sel.occurredAt} />
            <KV k="receivedAt" v={sel.receivedAt} />
            <KV k="admittedAt" v={sel.admittedAt} />
            <KV
              k="proposal"
              v={
                sel.proposalId ? (
                  <JumpLink onClick={() => onJumpProposal(sel.proposalId!)} title="Open proposal">
                    {sel.proposalId}
                  </JumpLink>
                ) : null
              }
            />
            <KV
              k="run"
              v={
                sel.runId ? (
                  <JumpLink onClick={() => onJumpRun(sel.runId!)} title="Open run">
                    {sel.runId}
                  </JumpLink>
                ) : null
              }
            />
          </Section>

          {(sel.planFailures > 0 || sel.lastPlanError) && (
            <Section title="Planning">
              <KV k="planFailures" v={String(sel.planFailures)} />
              {sel.lastPlanError && (
                <div
                  className="mt-1.5 rounded-md px-2.5 py-1.5 text-[12px]"
                  style={{
                    color: "var(--hue-err)",
                    background: "color-mix(in oklch, var(--hue-err) 10%, transparent)",
                  }}
                >
                  {sel.lastPlanError}
                </div>
              )}
            </Section>
          )}

          <Section title="Envelope">
            <Disclosure label="payload JSON">
              <JsonBlock value={sel.envelope} />
            </Disclosure>
          </Section>

          <div className="flex flex-col gap-2">
            <div className="flex gap-2">
              {canRequeue && (
                <Button
                  variant="primary"
                  disabled={!connected || requeue.isPending}
                  onClick={() => requeue.mutate(sel)}
                >
                  Requeue <span className="mono ml-1 opacity-70">q</span>
                </Button>
              )}
              <Button disabled={!connected || replay.isPending} onClick={() => setConfirmReplay(true)}>
                Replay through intake…
              </Button>
              <Button
                disabled={!connected}
                onClick={() => onTriggerAgain(retriggerEnvelope(sel.envelope, Date.now()))}
              >
                Trigger again…
              </Button>
            </div>
            <div className="text-[11px] leading-relaxed text-(--text-faint)">
              Requeue re-plans this already-admitted event. Replay re-injects the envelope through
              intake (dedup demo — a known id is a no-op). Trigger again opens inject with a fresh
              event id so it admits as a new event.
            </div>
          </div>
          <VerbError error={requeue.error ?? replay.error} />
        </div>
      )}

      {confirmReplay && sel && (
        <Dialog title={`Replay ${sel.eventId} through intake?`} onClose={() => setConfirmReplay(false)}>
          <div className="mb-3 text-[12px] text-(--text-dim)">
            Replay re-injects this envelope through the same admission path as a webhook. If the
            event id already exists, intake reports a duplicate and does nothing. This does not
            re-plan a dead letter — use Requeue for that.
          </div>
          <VerbError error={replay.error} />
          <div className="mt-3 flex justify-end gap-2">
            <Button onClick={() => setConfirmReplay(false)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={!connected || replay.isPending}
              onClick={() => replay.mutate(sel.envelope)}
            >
              Replay
            </Button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
