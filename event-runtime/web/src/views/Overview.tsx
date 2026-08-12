import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { api } from "../api";
import { useNow } from "../hooks";
import type { JournalEntry } from "../types";
import {
  ago,
  Button,
  Disclosure,
  EVENT_STATUS_HUES,
  JsonBlock,
  Section,
  STATE_HUES,
  StatTile,
  VerbError,
} from "../components/ui";

const FEED_CAP = 50;

/**
 * Live activity feed off GET /journal: first fetch seeds the latest entries,
 * then each 2 s poll asks only for `since=<last head>` and prepends what is
 * new — an append-only log consumed incrementally, capped at FEED_CAP shown.
 */
function useJournalFeed(): JournalEntry[] {
  const headRef = useRef(0);
  const [entries, setEntries] = useState<JournalEntry[]>([]);
  useQuery({
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
  return entries;
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
  onNavigate,
}: {
  connected: boolean;
  onJumpRun: (runId: string) => void;
  onJumpProposal: (id: string) => void;
  onJumpEvents: (status: string) => void;
  onNavigate: (view: string) => void;
}) {
  const now = useNow();
  const queryClient = useQueryClient();
  const status = useQuery({ queryKey: ["status"], queryFn: api.status, refetchInterval: 2000 });
  const outbox = useQuery({
    queryKey: ["outbox"],
    queryFn: () => api.outbox(15),
    refetchInterval: 2000,
  });
  const feed = useJournalFeed();

  const requeue = useMutation({
    mutationFn: ({ source, eventId }: { source: string; eventId: string }) => api.requeue(source, eventId),
    onSuccess: () => queryClient.invalidateQueries(),
    onError: () => queryClient.invalidateQueries(),
  });

  const s = status.data;
  const anomalies = s?.anomalies;
  const anomalyRows: { text: string; linkLabel: string; link: () => void; requeue?: { source: string; eventId: string } }[] = [];
  if (anomalies) {
    for (const id of anomalies.expiredOpenProposals) {
      anomalyRows.push({ text: `expired open proposal ${id}`, linkLabel: "View proposal", link: () => onJumpProposal(id) });
    }
    if (anomalies.staleLeases > 0) {
      anomalyRows.push({ text: `stale leases: ${anomalies.staleLeases}`, linkLabel: "View runs", link: () => onNavigate("runs") });
    }
    if (anomalies.unpublishedOutbox > 0) {
      anomalyRows.push({
        text: `unpublished outbox rows: ${anomalies.unpublishedOutbox}`,
        linkLabel: "View outbox",
        link: () => onNavigate("overview"),
      });
    }
    for (const d of anomalies.deadLettered) {
      anomalyRows.push({
        text: `dead-lettered (${d.source}, ${d.eventId}): ${d.lastError ?? "unknown error"}`,
        linkLabel: "View event",
        link: () => onJumpEvents("dead_lettered"),
        requeue: { source: d.source, eventId: d.eventId },
      });
    }
  }

  return (
    <div className="h-full min-w-0 overflow-auto p-5">
      <h1 className="display mb-4 text-lg font-semibold">Overview</h1>

      {s && (
        <div className="mb-5 grid grid-cols-4 gap-2 xl:grid-cols-8">
          {Object.entries(s.events).map(([k, v]) => (
            <StatTile key={k} label={`events · ${k}`} value={v} hue={v > 0 ? EVENT_STATUS_HUES[k] : undefined} />
          ))}
          <StatTile label="proposals · open" value={s.proposals.open} hue={s.proposals.open > 0 ? "var(--hue-info)" : undefined} />
          <StatTile label="proposals · expired" value={s.proposals.expired} hue={s.proposals.expired > 0 ? "var(--hue-warn)" : undefined} />
          {Object.entries(s.runs.byState).map(([k, v]) => (
            <StatTile key={k} label={`runs · ${k.toLowerCase()}`} value={v ?? 0} />
          ))}
        </div>
      )}

      <Section title="Doctor">
        {anomalyRows.length === 0 ? (
          <div className="text-(--text-faint)">No anomalies.</div>
        ) : (
          <div className="rounded-md border border-(--border)">
            {anomalyRows.map((a, i) => (
              <div key={i} className="flex items-center justify-between gap-3 border-b border-(--border) px-3 py-2 last:border-0">
                <span className="truncate" style={{ color: "var(--hue-warn)" }}>
                  {a.text}
                </span>
                <span className="flex shrink-0 gap-2">
                  {a.requeue && (
                    <Button
                      disabled={!connected || requeue.isPending}
                      onClick={() => requeue.mutate(a.requeue!)}
                    >
                      Requeue
                    </Button>
                  )}
                  <Button onClick={a.link}>{a.linkLabel}</Button>
                </span>
              </div>
            ))}
          </div>
        )}
        <VerbError error={requeue.error} />
      </Section>

      <div className="grid gap-x-5 xl:grid-cols-2">
        <Section title={`Activity · latest ${Math.min(feed.length, FEED_CAP)}`}>
          {feed.length === 0 ? (
            <div className="text-(--text-faint)">No lifecycle activity yet.</div>
          ) : (
            <div className="rounded-md border border-(--border) px-3 py-1">
              {feed.map((e) => (
                <div key={e.seq} className="flex items-baseline gap-2 border-b border-(--border) py-1.5 last:border-0">
                  <span className="mono w-[52px] shrink-0 text-(--text-faint)">{ago(e.at, now)}</span>
                  <button
                    type="button"
                    onClick={() => onJumpRun(e.runId)}
                    className="mono max-w-36 shrink-0 truncate text-left hover:text-(--accent)"
                    title={e.runId}
                  >
                    {e.runId}
                  </button>
                  <span className="shrink-0 text-(--text-faint)">
                    {e.from ?? "·"} →{" "}
                    <span style={{ color: STATE_HUES[e.to] ?? "var(--text-dim)" }}>{e.to}</span>
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
          {(outbox.data?.outbox ?? []).length === 0 ? (
            <div className="text-(--text-faint)">Nothing published yet.</div>
          ) : (
            <div className="rounded-md border border-(--border) px-3 py-1">
              {(outbox.data?.outbox ?? []).map((o) => (
                <div key={o.seq} className="border-b border-(--border) py-1.5 last:border-0">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="truncate text-(--text-dim)">{String(o.event.type ?? "unknown event")}</span>
                    {o.published_at ? (
                      <span className="mono shrink-0 text-(--text-faint)">{ago(o.published_at, now)}</span>
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
        </Section>
      </div>
    </div>
  );
}
