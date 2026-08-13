import { useQuery } from "@tanstack/react-query";
import { Fragment, useEffect, useRef } from "react";
import { api } from "../api";
import type { RunState, TraceEntry, TracePayload } from "../types";
import { Disclosure, humanSize, JsonBlock, Section } from "./ui";

/** States in which the trace is still being written — poll incrementally. */
const LIVE_STATES: RunState[] = ["LEASED", "RUNNING", "VERIFYING"];

/** Server page cap; the recorder's row cap (2000 + 1 marker) is ≤ 5 pages. */
const PAGE = 500;

/**
 * Incremental trace feed, same pattern as the Overview journal feed: each
 * poll passes `since=<last received seq>` and appends only what is new. The
 * cursor is the last *received* seq — never the server head, which would
 * skip rows whenever a read filled a whole page. The accumulated array lives
 * in the query cache (keyed per run), so a re-mounted detail pane renders a
 * terminal run's full trace without refetching.
 */
function useTraceFeed(runId: string, live: boolean) {
  const acc = useRef<TraceEntry[]>([]);
  const cursor = useRef(0);
  const query = useQuery<TraceEntry[]>({
    queryKey: ["trace", runId],
    queryFn: async () => {
      // Page forward until caught up — bounded by the recorder's row cap.
      for (;;) {
        const res = await api.trace(runId, cursor.current, PAGE);
        if (res.entries.length) {
          const seen = new Set(acc.current.map((e) => e.seq));
          acc.current = [...acc.current, ...res.entries.filter((e) => !seen.has(e.seq))];
          cursor.current = res.entries[res.entries.length - 1].seq;
        }
        if (res.entries.length < PAGE) break;
      }
      return acc.current;
    },
    // ~1.5 s while the agent runs; terminal/pre-execution runs fetch once on
    // mount (historical traces stay browsable) and stop polling.
    refetchInterval: live ? 1500 : false,
  });

  // One catch-up read when the run leaves the live states: the tail written
  // between the last poll and the terminal transition must not be lost.
  const wasLive = useRef(live);
  useEffect(() => {
    if (wasLive.current && !live) query.refetch();
    wasLive.current = live;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live]);

  const entries = query.data ?? [];
  return {
    entries,
    isPending: query.isPending && entries.length === 0,
    isError: query.isError && entries.length === 0,
  };
}

function TextBlock({ text }: { text: string }) {
  return (
    <pre className="mono overflow-auto rounded-md border border-(--border) bg-(--surface-0) p-3 leading-relaxed whitespace-pre-wrap">
      {text}
    </pre>
  );
}

/** One trace row body, by kind. The recorder's truncation marker wins. */
function TraceBody({ kind, p }: { kind: string; p: TracePayload }) {
  // Oversize payload clipped in place: whatever the kind was, only the
  // preview survives — say so rather than rendering half a payload silently.
  if (p.truncated) {
    return (
      <div className="min-w-0 flex-1">
        <span className="text-[11px]" style={{ color: "var(--hue-warn)" }}>
          {kind} payload truncated · original {humanSize(p.originalBytes ?? 0)}
        </span>
        {p.preview && (
          <Disclosure label="preview">
            <TextBlock text={p.preview} />
          </Disclosure>
        )}
      </div>
    );
  }
  if (kind === "assistant_text") {
    return <div className="min-w-0 flex-1 whitespace-pre-wrap text-(--text-dim)">{p.text ?? ""}</div>;
  }
  if (kind === "tool_use") {
    return (
      <div className="min-w-0 flex-1">
        <span className="mono">🔧 {p.name ?? "unknown tool"}</span>
        {p.input !== undefined && (
          <Disclosure label="input">
            <JsonBlock value={p.input} />
          </Disclosure>
        )}
      </div>
    );
  }
  if (kind === "tool_result") {
    return (
      <div className="min-w-0 flex-1">
        <Disclosure
          label={
            p.isError ? (
              <span style={{ color: "var(--hue-err)" }}>tool result — error</span>
            ) : (
              "tool result"
            )
          }
        >
          {typeof p.content === "string" ? <TextBlock text={p.content} /> : <JsonBlock value={p.content ?? null} />}
        </Disclosure>
      </div>
    );
  }
  if (kind === "usage") {
    return (
      <div className="min-w-0 flex-1 text-(--text-faint)">
        {p.numTurns ?? "?"} turns · {p.durationMs != null ? `${(p.durationMs / 1000).toFixed(1)}s` : "?"} ·{" "}
        {p.costUSD != null ? `$${p.costUSD.toFixed(4)}` : "?"}
        {p.usage && Object.keys(p.usage).length > 0 && (
          <Disclosure label="tokens">
            <JsonBlock value={p.usage} />
          </Disclosure>
        )}
      </div>
    );
  }
  if (kind === "lifecycle") {
    if (p.note === "trace_truncated") {
      return (
        <div className="min-w-0 flex-1" style={{ color: "var(--hue-warn)" }}>
          trace truncated — {p.dropped ?? "?"} event{p.dropped === 1 ? "" : "s"} dropped past the cap
        </div>
      );
    }
    return <div className="min-w-0 flex-1 text-(--text-faint)">{p.note ?? "lifecycle"}</div>;
  }
  // Unknown kind (future factory.trace versions): show, do not reinterpret.
  return (
    <div className="min-w-0 flex-1">
      <Disclosure label={kind}>
        <JsonBlock value={p} />
      </Disclosure>
    </div>
  );
}

/**
 * Trace (webui doc §10.10) — the factory.trace/v1 stream in the run detail:
 * what the model is saying and which tools it is calling, live while the run
 * executes, browsable afterwards. Mount with key={runId}.
 */
export function RunTrace({ runId, state }: { runId: string; state: RunState }) {
  const live = LIVE_STATES.includes(state);
  const { entries, isPending, isError } = useTraceFeed(runId, live);

  // Multi-attempt runs: divider per attempt (entries are seq-ascending, so
  // attempts are contiguous). A single attempt needs no labels.
  const multiAttempt = new Set(entries.map((e) => e.attempt)).size > 1;

  // Follow the stream: while live, keep the scroll pinned to the newest entry.
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (live && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [entries.length, live]);

  return (
    <Section title={`Trace${entries.length ? ` · ${entries.length}` : ""}`}>
      {live && (
        <div className="mb-1.5 flex items-center gap-1.5 text-[11px]" style={{ color: "var(--hue-warn)" }}>
          <span className="size-1.5 animate-pulse rounded-full" style={{ background: "var(--hue-warn)" }} />
          live — following the running attempt
        </div>
      )}
      {entries.length === 0 ? (
        <div className="text-(--text-faint)">
          {isPending
            ? "Loading trace…"
            : isError
              ? "Could not load the trace."
              : live
                ? "No trace yet — events appear here as the agent works."
                : "No trace — this adapter does not stream events."}
        </div>
      ) : (
        <div ref={scroller} className="max-h-96 overflow-auto rounded-md border border-(--border) px-3 py-1">
          {entries.map((e, i) => (
            <Fragment key={e.seq}>
              {multiAttempt && (i === 0 || entries[i - 1].attempt !== e.attempt) && (
                <div className="border-b border-(--border) py-1 text-[11px] font-medium tracking-wide text-(--text-faint) uppercase">
                  Attempt #{e.attempt}
                </div>
              )}
              <div className="flex items-baseline gap-2 border-b border-(--border) py-1.5 last:border-0">
                <span className="mono w-[64px] shrink-0 text-(--text-faint)" title={e.ts}>
                  {new Date(e.ts).toLocaleTimeString([], { hour12: false })}
                </span>
                <TraceBody kind={e.kind} p={e.payload ?? {}} />
              </div>
            </Fragment>
          ))}
        </div>
      )}
    </Section>
  );
}
