import { useQuery } from "@tanstack/react-query";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import type { RunState, TraceEntry, TracePayload } from "../types";
import { Disclosure, humanSize, JsonBlock, Section } from "./ui";

/** States in which the trace is still being written — poll incrementally. */
const LIVE_STATES: RunState[] = ["LEASED", "RUNNING", "VERIFYING"];

/** Server page cap; the recorder's row cap (2000 + 1 marker) is ≤ 5 pages. */
const PAGE = 500;

/** Panel tail: triage shows the newest activity; reading happens full-page. */
const PANEL_TAIL = 20;

type TraceFilterKind = "all" | "tools" | "reasoning" | "errors" | "usage";

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
        // Fall back to plain text if not valid JSON
      }
    }
    return <TextBlock text={content} />;
  }
  return <JsonBlock value={content ?? null} />;
}

function getEntryDuration(e: TraceEntry, next?: TraceEntry): number | null {
  if (e.payload?.durationMs != null) return e.payload.durationMs;
  if (!next) return null;
  const delta = Date.parse(next.ts) - Date.parse(e.ts);
  return Number.isNaN(delta) || delta < 0 ? null : delta;
}

function TimingWaterfall({ durationMs, maxMs }: { durationMs: number; maxMs: number }) {
  const pct = Math.min(100, Math.max(8, (durationMs / (maxMs || 1)) * 100));
  const durLabel = durationMs >= 1000 ? `${(durationMs / 1000).toFixed(1)}s` : `${durationMs}ms`;
  return (
    <div className="flex items-center gap-1.5 mono text-[10px] text-(--text-faint)" title={`Execution time: ${durLabel}`}>
      <div className="h-1.5 w-12 overflow-hidden rounded-full bg-(--surface-2)">
        <div className="h-full rounded-full bg-(--accent) opacity-80" style={{ width: `${pct}%` }} />
      </div>
      <span>{durLabel}</span>
    </div>
  );
}

/** One trace row body, by kind. The recorder's truncation marker wins. */
function TraceBody({
  kind,
  p,
  forceOpen,
  durationMs,
  maxMs,
}: {
  kind: string;
  p: TracePayload;
  forceOpen?: boolean;
  durationMs?: number | null;
  maxMs?: number;
}) {
  // Oversize payload clipped in place: whatever the kind was, only the
  // preview survives — say so rather than rendering half a payload silently.
  if (p.truncated) {
    return (
      <div className="min-w-0 flex-1">
        <span className="text-[11px]" style={{ color: "var(--hue-warn)" }}>
          {kind} payload truncated · original {humanSize(p.originalBytes ?? 0)}
        </span>
        {p.preview && (
          <Disclosure label="preview" defaultOpen={forceOpen ?? false}>
            <ContentBlock content={p.preview} />
          </Disclosure>
        )}
      </div>
    );
  }
  if (kind === "assistant_text") {
    return (
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <div className="whitespace-pre-wrap text-(--text-dim)">{p.text ?? ""}</div>
          {durationMs != null && maxMs != null && <TimingWaterfall durationMs={durationMs} maxMs={maxMs} />}
        </div>
      </div>
    );
  }
  if (kind === "tool_use") {
    return (
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="mono">🔧 {p.name ?? "unknown tool"}</span>
          {durationMs != null && maxMs != null && <TimingWaterfall durationMs={durationMs} maxMs={maxMs} />}
        </div>
        {p.input !== undefined && (
          <Disclosure label="input" defaultOpen={forceOpen ?? false}>
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
          defaultOpen={forceOpen ?? false}
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
          <Disclosure label="tokens" defaultOpen={forceOpen ?? false}>
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
      <Disclosure label={kind} defaultOpen={forceOpen ?? false}>
        <JsonBlock value={p} />
      </Disclosure>
    </div>
  );
}

const isToolKind = (k: string) => k === "tool_use" || k === "tool_result";
const isReasoningKind = (k: string) => k === "assistant_text";
const isErrorKind = (e: TraceEntry) =>
  (e.kind === "tool_result" && Boolean(e.payload?.isError)) ||
  (e.kind === "lifecycle" && e.payload?.note === "trace_truncated");
const isUsageKind = (k: string) => k === "usage";

/**
 * Trace (webui doc §10.10, §10.11, controls OPS-358) — the factory.trace/v1 stream:
 * what the model is saying and which tools it is calling, live while the run
 * executes, browsable afterwards. Mount with key={runId}.
 *
 * One component, two presentations (the poller is shared, never forked):
 * - `panel` (default): a Section in the run detail panel, tail-only past
 *   PANEL_TAIL entries with an "open full view" jump (`onExpand`).
 * - `full`: the main column of `#/run/:id` — everything, plus client-side
 *   kind filter chips, expand-all toggle, and syntax highlighting.
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
  const [filter, setFilter] = useState<TraceFilterKind>("all");
  const [expandAll, setExpandAll] = useState<boolean>(false);
  const [search, setSearch] = useState<string>("");
  const [activeMatch, setActiveMatch] = useState<number>(0);
  const [autoScrollPaused, setAutoScrollPaused] = useState<boolean>(false);

  const counts = useMemo(() => {
    let tools = 0;
    let reasoning = 0;
    let errors = 0;
    let usage = 0;
    for (const e of entries) {
      if (isToolKind(e.kind)) tools++;
      if (isReasoningKind(e.kind)) reasoning++;
      if (isErrorKind(e)) errors++;
      if (isUsageKind(e.kind)) usage++;
    }
    return { all: entries.length, tools, reasoning, errors, usage };
  }, [entries]);

  const tokenStats = useMemo(() => {
    let promptTokens = 0;
    let completionTokens = 0;
    let totalCost = 0;
    let hasTokens = false;
    for (const e of entries) {
      if (e.payload?.usage) {
        hasTokens = true;
        const u = e.payload.usage;
        promptTokens += u.input_tokens ?? u.prompt_tokens ?? u.inputTokens ?? 0;
        completionTokens += u.output_tokens ?? u.completion_tokens ?? u.outputTokens ?? 0;
      }
      if (e.payload?.costUSD) totalCost += e.payload.costUSD;
    }
    return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens, totalCost, hasTokens };
  }, [entries]);

  const visibleEntries = useMemo(() => {
    if (filter === "all") return entries;
    if (filter === "tools") return entries.filter((e) => isToolKind(e.kind));
    if (filter === "reasoning") return entries.filter((e) => isReasoningKind(e.kind));
    if (filter === "errors") return entries.filter(isErrorKind);
    if (filter === "usage") return entries.filter((e) => isUsageKind(e.kind));
    return entries;
  }, [entries, filter]);

  const tailCut = !full && visibleEntries.length > PANEL_TAIL;
  const shown = tailCut ? visibleEntries.slice(-PANEL_TAIL) : visibleEntries;

  // Waterfall timing calculations:
  const { durations, maxDurationMs } = useMemo(() => {
    const map = new Map<number, number>();
    let max = 0;
    for (let i = 0; i < shown.length; i++) {
      const dur = getEntryDuration(shown[i], shown[i + 1]);
      if (dur != null) {
        map.set(shown[i].seq, dur);
        if (dur > max) max = dur;
      }
    }
    return { durations: map, maxDurationMs: max || 1000 };
  }, [shown]);

  // In-trace text search matches:
  const searchMatches = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return [];
    const matches: number[] = [];
    for (let i = 0; i < shown.length; i++) {
      const e = shown[i];
      const text = [
        e.kind,
        e.payload?.text,
        e.payload?.name,
        e.payload?.note,
        typeof e.payload?.input === "object" ? JSON.stringify(e.payload.input) : String(e.payload?.input ?? ""),
        typeof e.payload?.content === "object" ? JSON.stringify(e.payload.content) : String(e.payload?.content ?? ""),
      ].join(" ").toLowerCase();
      if (text.includes(q)) matches.push(i);
    }
    return matches;
  }, [shown, search]);

  const scroller = useRef<HTMLDivElement>(null);

  // Jump to active search match:
  useEffect(() => {
    if (searchMatches.length > 0 && scroller.current) {
      const idx = searchMatches[activeMatch % searchMatches.length];
      const el = scroller.current.querySelector(`[data-trace-idx="${idx}"]`);
      el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [activeMatch, searchMatches]);

  // Live auto-scroll:
  useEffect(() => {
    if (live && !autoScrollPaused && scroller.current) {
      scroller.current.scrollTop = scroller.current.scrollHeight;
    }
  }, [shown.length, live, autoScrollPaused]);

  const onScrollHandler = () => {
    if (!scroller.current || !live) return;
    const { scrollTop, scrollHeight, clientHeight } = scroller.current;
    const atBottom = scrollHeight - scrollTop - clientHeight < 30;
    setAutoScrollPaused(!atBottom);
  };

  // Multi-attempt runs: divider per attempt (entries are seq-ascending, so
  // attempts are contiguous). A single attempt needs no labels.
  const multiAttempt = new Set(shown.map((e) => e.attempt)).size > 1;

  const filterTabs: { key: TraceFilterKind; label: string; count: number }[] = [
    { key: "all", label: "All", count: counts.all },
    { key: "tools", label: "Tools", count: counts.tools },
    { key: "reasoning", label: "Reasoning", count: counts.reasoning },
    { key: "errors", label: "Errors", count: counts.errors },
    { key: "usage", label: "Usage", count: counts.usage },
  ];

  const body = (
    <>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        {live ? (
          <div className="flex items-center gap-1.5 text-[11px]" style={{ color: "var(--hue-warn)" }}>
            <span className="size-1.5 animate-pulse rounded-full" style={{ background: "var(--hue-warn)" }} />
            live — following the running attempt
          </div>
        ) : <div />}

        {tokenStats.hasTokens && (
          <div className="flex items-center gap-1.5 rounded bg-(--surface-1) border border-(--border) px-2 py-0.5 text-[10.5px] mono text-(--text-dim)">
            <span title="Cumulative token burn across trace">🔥 {tokenStats.promptTokens.toLocaleString()} in · {tokenStats.completionTokens.toLocaleString()} out</span>
            {tokenStats.totalCost > 0 && <span className="text-(--text-faint)">(${tokenStats.totalCost.toFixed(4)})</span>}
          </div>
        )}
      </div>

      {entries.length > 0 && (
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap gap-1">
            {filterTabs.map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => setFilter(t.key)}
                className={`rounded px-2 py-0.5 text-[11px] font-medium transition-colors ${
                  filter === t.key
                    ? "bg-(--surface-3) text-(--text)"
                    : "text-(--text-faint) hover:bg-(--surface-2)"
                }`}
                style={t.key === "errors" && t.count > 0 ? { color: "var(--hue-err)" } : undefined}
              >
                {t.label}
                {t.count > 0 && <span className="ml-1 tabular-nums opacity-75">{t.count}</span>}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1 rounded border border-(--border) bg-(--surface-0) px-1.5 py-0.5 text-[11px]">
              <input
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setActiveMatch(0);
                }}
                placeholder="Search trace…"
                className="w-24 bg-transparent outline-none text-(--text) placeholder:text-(--text-faint) sm:w-32"
              />
              {search && (
                <>
                  <span className="mono text-[10px] text-(--text-faint)">
                    {searchMatches.length ? `${(activeMatch % searchMatches.length) + 1}/${searchMatches.length}` : "0"}
                  </span>
                  {searchMatches.length > 0 && (
                    <>
                      <button
                        type="button"
                        onClick={() => setActiveMatch((m) => (m - 1 + searchMatches.length) % searchMatches.length)}
                        className="text-(--text-faint) hover:text-(--text)"
                        title="Previous match"
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        onClick={() => setActiveMatch((m) => (m + 1) % searchMatches.length)}
                        className="text-(--text-faint) hover:text-(--text)"
                        title="Next match"
                      >
                        ↓
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    onClick={() => setSearch("")}
                    className="text-(--text-faint) hover:text-(--text)"
                  >
                    ✕
                  </button>
                </>
              )}
            </div>
            <button
              type="button"
              onClick={() => setExpandAll((v) => !v)}
              className="text-[11px] text-(--text-faint) hover:text-(--text-dim)"
            >
              {expandAll ? "Collapse details" : "Expand details"}
            </button>
          </div>
        </div>
      )}

      {visibleEntries.length === 0 ? (
        <div className="text-(--text-faint)">
          {isPending
            ? "Loading trace…"
            : isError
              ? "Could not load the trace."
              : entries.length > 0
                ? `No entries match "${filter}".`
                : live
                  ? "No trace yet — events appear here as the agent works."
                  : "No trace — this adapter does not stream events."}
        </div>
      ) : (
        <div className="relative">
          <div
            ref={scroller}
            onScroll={onScrollHandler}
            className={`${
              full ? "max-h-[70vh]" : "max-h-96"
            } overflow-auto rounded-md border border-(--border) px-3 py-1`}
          >
            {shown.map((e, i) => {
              const isMatch = searchMatches.includes(i);
              const isActiveMatch = searchMatches.length > 0 && searchMatches[activeMatch % searchMatches.length] === i;
              return (
                <Fragment key={`${e.seq}-${expandAll ? "open" : "shut"}`}>
                  {multiAttempt && (i === 0 || shown[i - 1].attempt !== e.attempt) && (
                    <div className="border-b border-(--border) py-1 text-[11px] font-medium tracking-wide text-(--text-faint) uppercase">
                      Attempt #{e.attempt}
                    </div>
                  )}
                  <div
                    data-trace-idx={i}
                    className={`flex items-baseline gap-2 border-b border-(--border) py-1.5 last:border-0 transition-colors ${
                      isActiveMatch ? "bg-(--surface-2) -mx-2 px-2 rounded" : isMatch ? "bg-(--surface-1) -mx-2 px-2 rounded" : ""
                    }`}
                  >
                    <span className="mono w-[64px] shrink-0 text-(--text-faint)" title={e.ts}>
                      {new Date(e.ts).toLocaleTimeString([], { hour12: false })}
                    </span>
                    <TraceBody
                      kind={e.kind}
                      p={e.payload ?? {}}
                      forceOpen={expandAll}
                      durationMs={durations.get(e.seq)}
                      maxMs={maxDurationMs}
                    />
                  </div>
                </Fragment>
              );
            })}
          </div>

          {live && autoScrollPaused && (
            <div className="absolute bottom-2 left-1/2 -translate-x-1/2 z-10">
              <button
                type="button"
                onClick={() => {
                  setAutoScrollPaused(false);
                  if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
                }}
                className="rounded-full bg-(--accent) px-3 py-1 text-[11px] font-medium text-white shadow-lg transition-transform hover:scale-105"
              >
                ↓ New trace events below
              </button>
            </div>
          )}
        </div>
      )}

      {tailCut && (
        <div className="mt-1.5 text-[11px] text-(--text-faint)">
          showing last {PANEL_TAIL} of {visibleEntries.length} entries
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
