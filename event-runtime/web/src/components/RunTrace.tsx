import { useQuery } from "@tanstack/react-query";
import { Fragment, useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { RunState, TraceEntry, TracePayload } from "../types";
import { Disclosure, humanSize, JsonBlock, Section } from "./ui";

/** States in which the trace is still being written — poll incrementally. */
const LIVE_STATES: RunState[] = ["LEASED", "RUNNING", "VERIFYING"];

/** Server page cap; the recorder's row cap (2000 + 1 marker) is ≤ 5 pages. */
const PAGE = 500;

/** Panel tail: triage shows the newest activity; reading happens full-page. */
const PANEL_TAIL = 20;

/** Kind filter chips (full view): usage and lifecycle share one toggle. */
const KIND_GROUPS = [
  { key: "assistant_text", label: "text" },
  { key: "tool_use", label: "tool calls" },
  { key: "tool_result", label: "tool results" },
  { key: "meta", label: "usage · lifecycle" },
] as const;

const groupOf = (kind: string): string =>
  kind === "usage" || kind === "lifecycle" ? "meta" : kind;

/**
 * Incremental trace feed, same pattern as the Overview journal feed: each
 * poll passes `since=<last received seq>` and appends only what is new. The
 * cursor is the last *received* seq — never the server head, which would
 * skip rows whenever a read filled a whole page. The accumulated array lives
 * in the query cache (keyed per run), so a re-mounted detail pane renders a
 * terminal run's full trace without refetching — and the panel and the
 * full-page view share one feed instead of polling twice.
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

function ContentBlock({ content }: { content: unknown }) {
  if (typeof content === "string") {
    const trimmed = content.trim();
    if (
      (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))
    ) {
      try {
        const parsed = JSON.parse(trimmed);
        return <JsonBlock value={parsed} />;
      } catch {
        // Fall back to plain text
      }
    }
    return <TextBlock text={content} />;
  }
  return <JsonBlock value={content ?? null} />;
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
            <ContentBlock content={p.preview} />
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
          <ContentBlock content={p.content} />
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
 * Trace (webui doc §10.10, §10.11) — the factory.trace/v1 stream: what the
 * model is saying and which tools it is calling, live while the run
 * executes, browsable afterwards. Mount with key={runId}.
 *
 * One component, two presentations (the poller is shared, never forked):
 * - `panel` (default): a Section in the run detail panel, tail-only past
 *   PANEL_TAIL entries with an "open full view" jump (`onExpand`).
 * - `full`: the main column of `#/run/:id` — everything, plus client-side
 *   kind filter chips over the cached entries. Filters never touch polling.
 */
export function RunTrace({
  runId,
  state,
  variant = "panel",
  onExpand,
}: {
  runId: string;
  state: RunState;
  variant?: "panel" | "full";
  onExpand?: () => void;
}) {
  const full = variant === "full";
  const live = LIVE_STATES.includes(state);
  const { entries, isPending, isError } = useTraceFeed(runId, live);

  // Full view: client-side kind visibility. Hidden groups, not shown ones,
  // so new kinds from a live poll are visible by default.
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const toggle = (key: string) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const filtered = full ? entries.filter((e) => !hidden.has(groupOf(e.kind))) : entries;
  const tailCut = !full && entries.length > PANEL_TAIL;
  const shown = tailCut ? entries.slice(-PANEL_TAIL) : filtered;

  // Multi-attempt runs: divider per attempt (entries are seq-ascending, so
  // attempts are contiguous). A single attempt needs no labels.
  const multiAttempt = new Set(entries.map((e) => e.attempt)).size > 1;

  // Follow the stream: while live, keep the scroll pinned to the newest entry.
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (live && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [shown.length, live]);

  const counts: Record<string, number> = {};
  for (const e of entries) counts[groupOf(e.kind)] = (counts[groupOf(e.kind)] ?? 0) + 1;

  const body = (
    <>
      {live && (
        <div className="mb-1.5 flex items-center gap-1.5 text-[11px]" style={{ color: "var(--hue-warn)" }}>
          <span className="size-1.5 animate-pulse rounded-full" style={{ background: "var(--hue-warn)" }} />
          live — following the running attempt
        </div>
      )}
      {full && entries.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1" role="group" aria-label="Trace kind filter">
          {KIND_GROUPS.map((g) => {
            const off = hidden.has(g.key);
            return (
              <button
                key={g.key}
                type="button"
                aria-pressed={!off}
                title={off ? `Show ${g.label} entries` : `Hide ${g.label} entries`}
                onClick={() => toggle(g.key)}
                className={`rounded-md px-2.5 py-1 text-[12px] font-medium ${
                  off
                    ? "text-(--text-faint) line-through hover:bg-(--surface-1)"
                    : "bg-(--surface-3) text-(--text)"
                }`}
              >
                {g.label}
                {(counts[g.key] ?? 0) > 0 && (
                  <span className="ml-1.5 tabular-nums text-(--text-faint)">{counts[g.key]}</span>
                )}
              </button>
            );
          })}
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
      ) : shown.length === 0 ? (
        <div className="text-(--text-faint)">
          All {entries.length} entries hidden by the kind filter.
        </div>
      ) : (
        <div
          ref={scroller}
          className={`${full ? "max-h-[70vh]" : "max-h-96"} overflow-auto rounded-md border border-(--border) px-3 py-1`}
        >
          {shown.map((e, i) => (
            <Fragment key={e.seq}>
              {multiAttempt && (i === 0 || shown[i - 1].attempt !== e.attempt) && (
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
      {tailCut && (
        <div className="mt-1.5 text-[11px] text-(--text-faint)">
          showing last {PANEL_TAIL} of {entries.length} entries
          {onExpand && (
            <>
              {" — "}
              <button type="button" onClick={onExpand} className="text-(--accent) hover:underline">
                open full view
              </button>
            </>
          )}
        </div>
      )}
    </>
  );

  if (full) {
    return (
      <div>
        <div className="display mb-2 text-[15px] font-semibold">
          Trace{entries.length ? <span className="ml-2 text-(--text-faint)">· {entries.length}</span> : null}
        </div>
        {body}
      </div>
    );
  }
  return <Section title={`Trace${entries.length ? ` · ${entries.length}` : ""}`}>{body}</Section>;
}
