import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api";
import { useListKeys, useNow } from "../hooks";
import type { AdmittedEvent } from "../types";
import { ago, Button, JsonBlock, KV, Section, StatTile, VerbError } from "../components/ui";

const EVENT_STATUS_HUES: Record<string, string> = {
  admitted: "var(--hue-info)",
  planned: "var(--hue-ok)",
  noop: "var(--hue-idle)",
  human_needed: "var(--hue-warn)",
  dead_lettered: "var(--hue-err)",
};

/** Overview (webui spec §4.1): stat tiles, doctor panel, recent events inbox. */
export function Overview({ connected }: { connected: boolean }) {
  const now = useNow();
  const queryClient = useQueryClient();
  const status = useQuery({ queryKey: ["status"], queryFn: api.status, refetchInterval: 2000 });
  const events = useQuery({
    queryKey: ["events"],
    queryFn: () => api.events(),
    refetchInterval: 2000,
  });
  const [selected, setSelected] = useState(-1);
  const [open, setOpen] = useState(false);

  const rows = events.data?.events ?? [];
  useListKeys({
    count: rows.length,
    selected,
    onSelect: (i) => {
      setSelected(i);
      setOpen(true);
    },
    onOpen: () => selected >= 0 && setOpen(true),
    onClose: () => setOpen(false),
  });

  const replay = useMutation({
    mutationFn: (envelope: unknown) => api.replay(envelope),
    onSuccess: () => queryClient.invalidateQueries(),
  });

  const s = status.data;
  const anomalies = s?.anomalies;
  const anomalyLines: { text: string; envelope?: unknown }[] = [];
  if (anomalies) {
    for (const id of anomalies.expiredOpenProposals) anomalyLines.push({ text: `expired open proposal ${id}` });
    if (anomalies.staleLeases > 0) anomalyLines.push({ text: `stale leases: ${anomalies.staleLeases}` });
    if (anomalies.unpublishedOutbox > 0)
      anomalyLines.push({ text: `unpublished outbox rows: ${anomalies.unpublishedOutbox}` });
    for (const d of anomalies.deadLettered) {
      const event = rows.find((e) => e.source === d.source && e.eventId === d.eventId);
      anomalyLines.push({
        text: `dead-lettered (${d.source}, ${d.eventId}): ${d.lastError ?? "unknown error"}`,
        envelope: event?.envelope,
      });
    }
  }

  const sel: AdmittedEvent | undefined = rows[selected];

  return (
    <div className="flex h-full min-w-0">
      <div className="min-w-0 flex-1 overflow-auto p-5">
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
          {anomalyLines.length === 0 ? (
            <div className="text-(--text-faint)">No anomalies.</div>
          ) : (
            <div className="rounded-md border border-(--border)">
              {anomalyLines.map((a, i) => (
                <div key={i} className="flex items-center justify-between gap-3 border-b border-(--border) px-3 py-2 last:border-0">
                  <span style={{ color: "var(--hue-warn)" }}>{a.text}</span>
                  {a.envelope != null && (
                    <Button disabled={!connected || replay.isPending} onClick={() => replay.mutate(a.envelope)}>
                      Replay
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}
          <VerbError error={replay.error} />
        </Section>

        <Section title={`Events · ${rows.length}`}>
          <table className="w-full border-separate border-spacing-0">
            <thead>
              <tr className="text-left text-[11px] text-(--text-faint)">
                <th className="border-b border-(--border) px-3 py-1.5 font-medium">Event</th>
                <th className="border-b border-(--border) px-3 py-1.5 font-medium">Type</th>
                <th className="border-b border-(--border) px-3 py-1.5 font-medium">Status</th>
                <th className="border-b border-(--border) px-3 py-1.5 font-medium">Admitted</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e, i) => (
                <tr
                  key={`${e.source}:${e.eventId}`}
                  onClick={() => {
                    setSelected(i);
                    setOpen(true);
                  }}
                  className={`cursor-pointer hover:bg-(--surface-1) ${i === selected ? "row-selected" : ""}`}
                >
                  <td className="mono border-b border-(--border) px-3 py-1.5">{e.eventId}</td>
                  <td className="border-b border-(--border) px-3 py-1.5 text-(--text-dim)">{e.type}</td>
                  <td className="border-b border-(--border) px-3 py-1.5">
                    <span style={{ color: EVENT_STATUS_HUES[e.status] ?? "var(--text-dim)" }}>{e.status}</span>
                  </td>
                  <td className="border-b border-(--border) px-3 py-1.5 text-(--text-faint)">{ago(e.admittedAt, now)}</td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-3 py-8 text-center text-(--text-faint)">
                    No events yet — inject one with ⌘K → Inject event.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Section>
      </div>

      {open && sel && (
        <div className="w-[440px] shrink-0 overflow-auto border-l border-(--border) bg-(--surface-1) p-4">
          <div className="mb-3 flex items-center justify-between">
            <div className="display text-[14px] font-semibold">{sel.eventId}</div>
            <Button onClick={() => setOpen(false)}>Close</Button>
          </div>
          <Section title="Event">
            <KV k="source" v={sel.source} />
            <KV k="type" v={sel.type} />
            <KV k="subject" v={sel.subject} />
            <KV k="status" v={sel.status} />
            <KV k="correlationId" v={sel.correlationId} />
            <KV k="occurredAt" v={sel.occurredAt} />
            <KV k="admittedAt" v={sel.admittedAt} />
            {sel.planFailures > 0 && <KV k="planFailures" v={String(sel.planFailures)} />}
            {sel.lastPlanError && <KV k="lastPlanError" v={sel.lastPlanError} />}
          </Section>
          <Section title="Envelope">
            <JsonBlock value={sel.envelope} />
          </Section>
          <Button
            disabled={!connected || replay.isPending}
            onClick={() => replay.mutate(sel.envelope)}
          >
            Replay through intake
          </Button>
          <VerbError error={replay.error} />
        </div>
      )}
    </div>
  );
}
