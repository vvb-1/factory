import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { useListKeys, useNow } from "../hooks";
import { setContextActions } from "../palette";
import type { Worker } from "../types";
import {
  Ago,
  Button,
  DetailPane,
  FilterInput,
  JsonBlock,
  JumpLink,
  KV,
  ListEmpty,
  ListPane,
  Section,
  StateBadge,
  copyLink,
  copyText,
} from "../components/ui";

/** Four mutually exclusive tokens; `stale` is the loudest because it is a lie detector. */
const WORKER_HUES: Record<string, string> = {
  idle: "var(--hue-ok)",
  busy: "var(--hue-warn)",
  stopped: "var(--hue-idle)",
  stale: "var(--hue-err)",
};

/**
 * A stale heartbeat outranks whatever the row claims: a stale busy worker is
 * gone, not busy. `listWorkers` never marks a cleanly stopped worker stale, so
 * these four are disjoint.
 */
const health = (w: Worker) => (w.stale ? "stale" : w.state);

const labelText = (labels: Record<string, string>) =>
  Object.entries(labels)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ") || "-";

/** Runs already own `#/runs/:id`; the fleet is a way in, not a second router. */
const openRun = (runId: string) => {
  window.location.hash = `#/runs/${runId}`;
};

/**
 * Workers — the registry the CLI `workers` command prints, made legible. The
 * question this view answers is who could claim the next run and who only
 * looks like they could: a worker whose heartbeat has gone stale still reports
 * `busy` and still holds a run, and that gap is the whole point of the column.
 */
export function Workers({
  focusWorkerId,
  onSelectWorker,
}: {
  focusWorkerId: string | null;
  onSelectWorker: (id: string | null) => void;
}) {
  const now = useNow();
  const query = useQuery({ queryKey: ["workers"], queryFn: api.workers, refetchInterval: 2000 });
  const rows = query.data?.workers ?? [];

  const [filter, setFilter] = useState("");
  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((w) =>
      [w.workerId, w.host, String(w.pid), health(w), labelText(w.labels), w.adapters.join(","), w.currentRun].some(
        (v) => (v ?? "").toLowerCase().includes(q),
      ),
    );
  }, [rows, filter]);

  const selectedId = focusWorkerId;
  const selectedIndex = useMemo(
    () => visible.findIndex((w) => w.workerId === selectedId),
    [visible, selectedId],
  );
  const sel = selectedIndex >= 0 ? visible[selectedIndex] : null;

  useEffect(() => {
    document.querySelector("tr.row-selected")?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  useEffect(() => {
    if (focusWorkerId) setFilter("");
  }, [focusWorkerId]);

  useListKeys({
    count: visible.length,
    selected: selectedIndex,
    onSelect: (i) => onSelectWorker(visible[i]?.workerId ?? null),
    onClose: () => {
      if (selectedId) onSelectWorker(null);
      else if (filter) setFilter("");
    },
    keys: {
      c: () => sel && copyText(sel.workerId, "worker id"),
      o: () => sel?.currentRun && openRun(sel.currentRun),
    },
  });

  useEffect(() => {
    if (!sel) {
      setContextActions([]);
    } else {
      setContextActions([
        { label: `Copy ${sel.workerId}`, hint: "c", run: () => copyText(sel.workerId, "worker id") },
        ...(sel.currentRun
          ? [{ label: `Open run ${sel.currentRun}`, hint: "o", run: () => openRun(sel.currentRun!) }]
          : []),
        { label: "Copy link to this worker", run: copyLink },
      ]);
    }
    return () => setContextActions([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel?.workerId, sel?.currentRun]);

  return (
    <div className="flex h-full min-w-0">
      <ListPane
        chrome={
          <>
            <h1 className="display mb-4 text-lg font-semibold">Workers</h1>
            <div className="mb-3">
              <FilterInput
                value={filter}
                onChange={setFilter}
                placeholder="Filter worker, host, label, adapter…"
                label="Filter workers"
              />
            </div>
          </>
        }
      >
        <table className="w-full border-separate border-spacing-0">
          <thead>
            <tr className="text-left text-[11px] text-(--text-faint)">
              <th className="sticky top-0 z-10 bg-(--surface-0) border-b border-(--border) px-3 py-1.5 font-medium">Worker</th>
              <th className="sticky top-0 z-10 bg-(--surface-0) border-b border-(--border) px-3 py-1.5 font-medium">Host</th>
              <th className="sticky top-0 z-10 bg-(--surface-0) border-b border-(--border) px-3 py-1.5 font-medium">PID</th>
              <th className="sticky top-0 z-10 bg-(--surface-0) border-b border-(--border) px-3 py-1.5 font-medium">State</th>
              <th className="sticky top-0 z-10 bg-(--surface-0) border-b border-(--border) px-3 py-1.5 font-medium">Labels</th>
              <th className="sticky top-0 z-10 bg-(--surface-0) border-b border-(--border) px-3 py-1.5 font-medium">Adapters</th>
              <th className="sticky top-0 z-10 bg-(--surface-0) border-b border-(--border) px-3 py-1.5 font-medium">Current run</th>
              <th className="sticky top-0 z-10 bg-(--surface-0) border-b border-(--border) px-3 py-1.5 font-medium">Last seen</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((w, i) => (
              <tr
                key={w.workerId}
                onClick={() => onSelectWorker(w.workerId)}
                aria-selected={i === selectedIndex}
                className={`cursor-pointer hover:bg-(--surface-1) ${w.stale ? "row-wash-err" : ""} ${
                  i === selectedIndex ? "row-selected" : ""
                }`}
              >
                <td
                  className={`mono max-w-52 truncate border-b border-(--border) px-3 py-1.5 ${
                    w.state === "stopped" && !w.stale ? "text-(--text-faint)" : ""
                  }`}
                >
                  {w.workerId}
                </td>
                <td className="border-b border-(--border) px-3 py-1.5 text-(--text-dim)">{w.host}</td>
                <td className="border-b border-(--border) px-3 py-1.5 tabular-nums text-(--text-faint)">{w.pid}</td>
                <td className="border-b border-(--border) px-3 py-1.5">
                  <span className="flex items-baseline gap-1.5">
                    <StateBadge state={health(w)} hues={WORKER_HUES} />
                    {w.stale && (
                      <span className="text-[11px] text-(--text-faint)" title="What the worker last reported before its heartbeat stopped">
                        reported {w.state}
                      </span>
                    )}
                  </span>
                </td>
                <td className="max-w-48 truncate border-b border-(--border) px-3 py-1.5 text-(--text-dim)" title={labelText(w.labels)}>
                  {labelText(w.labels)}
                </td>
                <td className="max-w-40 truncate border-b border-(--border) px-3 py-1.5 text-(--text-faint)">
                  {w.adapters.join(", ") || "-"}
                </td>
                <td className="mono max-w-52 truncate border-b border-(--border) px-3 py-1.5 text-(--text-faint)">
                  {w.currentRun ? (
                    <JumpLink onClick={() => openRun(w.currentRun!)} title="Open this run">
                      {w.currentRun}
                    </JumpLink>
                  ) : (
                    "-"
                  )}
                </td>
                <td className="border-b border-(--border) px-3 py-1.5 text-(--text-faint)">
                  <Ago iso={w.lastSeen} now={now} className={w.stale ? "text-[color:var(--hue-err)]" : undefined} />
                </td>
              </tr>
            ))}
            {visible.length === 0 && (
              <ListEmpty
                colSpan={8}
                query={query}
                filtered={rows.length > 0}
                noun="workers"
                empty="No workers have registered — start one with bun event-runtime/cli.mjs work"
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
              <StateBadge state={health(sel)} hues={WORKER_HUES} />
              <span className="mono truncate" title={sel.workerId}>
                {sel.workerId}
              </span>
            </span>
          }
          actions={
            <>
              <Button onClick={() => copyText(sel.workerId, "worker id")}>Copy id</Button>
              <Button onClick={copyLink}>Copy link</Button>
              <Button onClick={() => onSelectWorker(null)}>Close</Button>
            </>
          }
        >
          {sel.stale && (
            <div
              className="mb-4 rounded-md px-2.5 py-1.5 text-[12px]"
              style={{
                color: "var(--hue-err)",
                background: "color-mix(in oklch, var(--hue-err) 10%, transparent)",
              }}
            >
              Heartbeat has gone stale — this process is gone, whatever it last reported
              {sel.currentRun ? ` (it still holds ${sel.currentRun}; the run is reclaimed when its lease expires)` : ""}.
            </div>
          )}

          <Section title="Process">
            <KV k="workerId" v={sel.workerId} />
            <KV k="host" v={sel.host} />
            <KV k="pid" v={String(sel.pid)} />
            <KV
              k="state"
              v={
                <span style={{ color: WORKER_HUES[sel.state] ?? "var(--hue-idle)" }}>
                  {sel.state}
                  {sel.stale ? " (last reported)" : ""}
                </span>
              }
            />
            <KV
              k="currentRun"
              v={
                sel.currentRun ? (
                  <JumpLink onClick={() => openRun(sel.currentRun!)} title="Open this run">
                    {sel.currentRun}
                  </JumpLink>
                ) : (
                  "-"
                )
              }
            />
            <KV k="startedAt" v={<Ago iso={sel.startedAt} now={now} />} />
            <KV k="lastSeen" v={<Ago iso={sel.lastSeen} now={now} />} />
            {sel.stoppedAt && <KV k="stoppedAt" v={<Ago iso={sel.stoppedAt} now={now} />} />}
          </Section>

          <Section title="Adapters">
            {sel.adapters.length === 0 ? (
              <div className="text-(--text-faint)">No adapters declared — this worker claims nothing.</div>
            ) : (
              <div className="rounded-md border border-(--border) px-3 py-1">
                {sel.adapters.map((a) => (
                  <div key={a} className="mono border-b border-(--border) py-1.5 last:border-0">
                    {a}
                  </div>
                ))}
              </div>
            )}
          </Section>

          <Section title="Labels">
            <div className="mb-1.5 text-[11px] text-(--text-faint)">
              Placement labels the worker declared at registration — what a run&apos;s placement
              constraints are matched against.
            </div>
            <JsonBlock value={sel.labels} />
          </Section>
        </DetailPane>
      )}
    </div>
  );
}
