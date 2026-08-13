import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { hashPath } from "../hash";
import { useNow } from "../hooks";
import type { JournalEntry, EventFocus } from "../types";
import {
  Ago,
  Button,
  Disclosure,
  EVENT_STATUS_HUES,
  JsonBlock,
  JumpLink,
  Section,
  StateBadge,
  StatTile,
  VerbError,
  ago,
  copyText,
  notify,
} from "../components/ui";

const FEED_CAP = 50;

/**
 * Workers has no jump callback from App (there is no `onJumpWorker`), so write
 * the hash the router already reads — a cross-view write, which pushes history
 * exactly like the nav rail does.
 */
function jumpWorkers(workerId?: string): void {
  window.location.hash = `#/${hashPath("workers", workerId)}`;
}

/**
 * Live activity feed off GET /journal: first fetch seeds the latest entries,
 * then each 2 s poll asks only for `since=<last head>` and prepends what is
 * new — an append-only log consumed incrementally, capped at FEED_CAP shown.
 */
function useJournalFeed(): { entries: JournalEntry[]; isPending: boolean; isError: boolean } {
  const headRef = useRef(0);
  const [entries, setEntries] = useState<JournalEntry[]>([]);
  const query = useQuery({
    queryKey: ["journal"],
    queryFn: async () => {
      const res = await api.journal(headRef.current, FEED_CAP);
      headRef.current = res.head;
      if (res.entries.length) {
        setEntries((prev) => {
          const seen = new Set(prev.map((e) => e.seq));
          const fresh = res.entries.filter((e) => !seen.has(e.seq));
          return fresh.length ? [...fresh, ...prev].slice(0, FEED_CAP) : prev;
        });
      }
      return res;
    },
    refetchInterval: 2000,
  });
  return {
    entries,
    isPending: query.isPending && entries.length === 0,
    isError: query.isError && entries.length === 0,
  };
}

/**
 * Overview (webui spec §4.1 + doc §10.4) — the dashboard: stat tiles, the
 * doctor panel with anomalies linking to their views, the live journal feed,
 * and the latest published result events from the outbox.
 */
export function Overview({
  connected,
  onJumpRun,
  onJumpProposal,
  onJumpEvents,
  onJumpRuns,
  onNavigate,
  onJumpExpired,
  onJumpGraph,
  onInject,
}: {
  connected: boolean;
  onJumpRun: (runId: string) => void;
  onJumpProposal: (id: string) => void;
  onJumpEvents: (focus: EventFocus) => void;
  onJumpRuns: (state?: string) => void;
  onNavigate: (view: string) => void;
  onJumpExpired: () => void;
  onJumpGraph: () => void;
  onInject: () => void;
}) {
  const now = useNow();
  const queryClient = useQueryClient();
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const status = useQuery({ queryKey: ["status"], queryFn: api.status, refetchInterval: 2000 });
  const outbox = useQuery({
    queryKey: ["outbox"],
    queryFn: () => api.outbox(15),
    refetchInterval: 2000,
  });
  const feed = useJournalFeed();

  const requeue = useMutation({
    mutationFn: ({ source, eventId }: { source: string; eventId: string }) => api.requeue(source, eventId),
    onSuccess: async (_, { source, eventId }) => {
      queryClient.invalidateQueries();
      notify(`Requeued event ${eventId}`, "ok");
      const deadline = Date.now() + 8000;
      try {
        while (alive.current && Date.now() < deadline) {
          const { proposals } = await api.proposals();
          const match = proposals.find((p) => p.eventSource === source && p.eventId === eventId);
          if (match && alive.current) {
            onJumpProposal(match.id);
            return;
          }
          await new Promise((r) => setTimeout(r, 250));
        }
      } catch {
        // The requeue itself landed; only the confirmation poll broke, so say
        // that rather than claiming no proposal appeared.
        if (alive.current) notify(`Requeued ${eventId} — could not confirm a proposal appeared`, "err");
        return;
      }
      if (alive.current) notify(`Requeued ${eventId} — no open proposal appeared`, "info");
    },
    onError: () => queryClient.invalidateQueries(),
  });

  const s = status.data;
  const anomalies = s?.anomalies;
  const anomalyRows: {
    text: string;
    links: { label: string; go: () => void }[];
    requeue?: { source: string; eventId: string };
  }[] = [];
  if (anomalies) {
    for (const id of anomalies.expiredOpenProposals) {
      anomalyRows.push({
        text: `expired open proposal ${id}`,
        links: [{ label: "View proposal", go: () => onJumpProposal(id) }],
      });
    }
    if (anomalies.staleLeases > 0) {
      anomalyRows.push({
        text: `stale leases: ${anomalies.staleLeases}`,
        links: [{ label: "View leased runs", go: () => onJumpRuns("LEASED") }],
      });
    }
    if (anomalies.unpublishedOutbox > 0) {
      anomalyRows.push({
        text: `unpublished outbox rows: ${anomalies.unpublishedOutbox}`,
        links: [
          {
            label: "View outbox",
            go: () => document.getElementById("outbox")?.scrollIntoView({ block: "start" }),
          },
        ],
      });
    }
    for (const d of anomalies.deadLettered) {
      anomalyRows.push({
        text: `dead-lettered (${d.source}, ${d.eventId}): ${d.lastError ?? "unknown error"}`,
        links: [
          {
            label: "View event",
            go: () => onJumpEvents({ status: "dead_lettered", source: d.source, eventId: d.eventId }),
          },
        ],
        requeue: { source: d.source, eventId: d.eventId },
      });
    }
    // A stale worker still holding a run: the process is gone but nothing has
    // reclaimed the run yet, so both ends of that gap need a jump.
    for (const w of anomalies.stalledWorkers) {
      anomalyRows.push({
        // Both ids lead, because the row truncates from the right: the age and
        // the host are the parts an operator can lose and still act.
        text: `stalled worker ${w.workerId} still holds run ${w.runId} — last heartbeat ${ago(w.lastSeen, now)} on ${w.host}`,
        links: [
          { label: "View worker", go: () => jumpWorkers(w.workerId) },
          { label: "View run", go: () => onJumpRun(w.runId) },
        ],
      });
    }
    if (anomalies.noWorkers) {
      // The count comes from the same snapshot the runtime derived noWorkers
      // from, so the sentence and the runs tile can never disagree.
      const queued = s?.runs.byState.QUEUED ?? 0;
      anomalyRows.push({
        text: `${queued} queued run${queued === 1 ? "" : "s"} and no live worker to claim ${queued === 1 ? "it" : "them"} — nothing will start until one registers`,
        links: [
          { label: "View workers", go: () => jumpWorkers() },
          { label: "View queued runs", go: () => onJumpRuns("QUEUED") },
        ],
      });
    }
  }

  return (
    <div className="h-full min-w-0 overflow-auto p-5">
      <div className="mb-4 flex items-baseline justify-between gap-3">
        <h1 className="display text-lg font-semibold">Overview</h1>
        <div className="flex gap-3 text-[12px] text-(--text-dim)">
          <button type="button" className="hover:text-(--accent)" onClick={onJumpGraph}>
            Graph
          </button>
          <button type="button" className="hover:text-(--accent)" onClick={onInject}>
            Inject event…
          </button>
        </div>
      </div>

      {status.isPending && !s && <div className="mb-5 text-(--text-faint)">Loading status…</div>}
      {status.isError && !s && (
        <div className="mb-5 text-(--text-faint)">Cannot reach the control API — tiles will appear when it is up.</div>
      )}

      {s && (
        <div className="mb-5 grid grid-cols-4 gap-2 xl:grid-cols-8">
          {Object.entries(s.events).map(([k, v]) => (
            <StatTile
              key={k}
              label={`events · ${k}`}
              value={v}
              hue={v > 0 ? EVENT_STATUS_HUES[k] : undefined}
              onClick={() => onJumpEvents({ status: k })}
            />
          ))}
          <StatTile
            label="proposals · open"
            value={s.proposals.open}
            hue={s.proposals.open > 0 ? "var(--hue-info)" : undefined}
            onClick={() => onNavigate("proposals")}
          />
          <StatTile
            label="proposals · expired"
            value={s.proposals.expired}
            hue={s.proposals.expired > 0 ? "var(--hue-warn)" : undefined}
            onClick={onJumpExpired}
          />
          {Object.entries(s.runs.byState).map(([k, v]) => (
            <StatTile
              key={k}
              label={`runs · ${k.toLowerCase()}`}
              value={v ?? 0}
              onClick={() => onJumpRuns(k)}
            />
          ))}
          <StatTile
            label="workers · live"
            value={s.workers.live}
            hue={s.workers.live > 0 ? "var(--hue-ok)" : undefined}
            onClick={() => jumpWorkers()}
          />
          <StatTile
            label="workers · busy"
            value={s.workers.busy}
            hue={s.workers.busy > 0 ? "var(--hue-info)" : undefined}
            onClick={() => jumpWorkers()}
          />
          <StatTile
            label="workers · stale"
            value={s.workers.stale}
            hue={s.workers.stale > 0 ? "var(--hue-warn)" : undefined}
            onClick={() => jumpWorkers()}
          />
        </div>
      )}

      <Section title="Doctor">
        {!s ? (
          <div className="text-(--text-faint)">
            {status.isError ? "Cannot reach the control API." : "Loading anomalies…"}
          </div>
        ) : anomalyRows.length === 0 ? (
          <div className="text-(--text-faint)">No anomalies.</div>
        ) : (
          <div className="rounded-md border border-(--border)">
            {anomalyRows.map((a, i) => (
              <div key={i} className="flex items-center justify-between gap-3 border-b border-(--border) px-3 py-2 last:border-0">
                <span className="truncate" title={a.text} style={{ color: "var(--hue-warn)" }}>
                  {a.text}
                </span>
                <span className="flex shrink-0 gap-2">
                  <Button onClick={() => copyText(a.text, "anomaly")}>Copy</Button>
                  {a.requeue && (
                    <Button
                      disabled={!connected || requeue.isPending}
                      onClick={() => requeue.mutate(a.requeue!)}
                    >
                      Requeue
                    </Button>
                  )}
                  {a.links.map((l) => (
                    <Button key={l.label} onClick={l.go}>
                      {l.label}
                    </Button>
                  ))}
                </span>
              </div>
            ))}
          </div>
        )}
        <VerbError error={requeue.error} />
      </Section>

      <div className="grid gap-x-5 xl:grid-cols-2">
        <Section title={`Activity · latest ${Math.min(feed.entries.length, FEED_CAP)}`}>
          {feed.entries.length === 0 ? (
            <div className="text-(--text-faint)">
              {feed.isPending
                ? "Loading activity…"
                : feed.isError
                  ? "Cannot reach the control API."
                  : "No lifecycle activity yet."}
            </div>
          ) : (
            <div className="rounded-md border border-(--border) px-3 py-1">
              {feed.entries.map((e) => (
                <div key={e.seq} className="flex items-baseline gap-2 border-b border-(--border) py-1.5 last:border-0">
                  <Ago iso={e.at} now={now} className="mono w-[52px] shrink-0 text-(--text-faint)" />
                  <JumpLink
                    onClick={() => onJumpRun(e.runId)}
                    title={e.runId}
                    className="max-w-36 shrink-0 truncate"
                  >
                    {e.runId}
                  </JumpLink>
                  <span className="shrink-0">
                    {e.from ?? "·"} → <StateBadge state={e.to} />
                  </span>
                  <span className="truncate text-(--text-faint)">
                    by {e.actor}
                    {e.reason ? ` (${e.reason})` : ""}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Section>

        <Section title="Outbox — published results">
          <div id="outbox">
          {(outbox.data?.outbox ?? []).length === 0 ? (
            <div className="text-(--text-faint)">
              {outbox.isPending && !outbox.data
                ? "Loading outbox…"
                : outbox.isError && !outbox.data
                  ? "Cannot reach the control API."
                  : "Nothing published yet."}
            </div>
          ) : (
            <div className="rounded-md border border-(--border) px-3 py-1">
              {(outbox.data?.outbox ?? []).map((o) => (
                <div key={o.seq} className="border-b border-(--border) py-1.5 last:border-0">
                  <div className="flex items-baseline justify-between gap-3">
                    {(() => {
                      const type = String(o.event.type ?? "unknown event");
                      const source = typeof o.event.source === "string" ? o.event.source : null;
                      const eventId = typeof o.event.eventId === "string" ? o.event.eventId : null;
                      return source && eventId ? (
                        <JumpLink
                          onClick={() => onJumpEvents({ source, eventId })}
                          title="Open origin event"
                          className="max-w-[70%] truncate"
                        >
                          {type}
                        </JumpLink>
                      ) : (
                        <span className="truncate text-(--text-dim)">{type}</span>
                      );
                    })()}
                    {o.published_at ? (
                      <Ago iso={o.published_at} now={now} className="mono shrink-0 text-(--text-faint)" />
                    ) : (
                      <span className="shrink-0 text-[11px]" style={{ color: "var(--hue-warn)" }}>
                        unpublished
                      </span>
                    )}
                  </div>
                  <Disclosure label="event JSON">
                    <JsonBlock value={o.event} />
                  </Disclosure>
                </div>
              ))}
            </div>
          )}
          </div>
        </Section>
      </div>
    </div>
  );
}
