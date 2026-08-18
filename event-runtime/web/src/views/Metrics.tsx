import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { fetchMetrics } from "../api";
import {
  Band,
  Sparkline,
  StackedBars,
  type BandDatum,
  type ChartLink,
  type StackedBarDatum,
} from "../components/Charts";
import { SegmentMeter } from "./Overview";
import type { MetricsView, MetricsWindow } from "../types";

export const METRICS_WINDOW_KEY = "evrt-metrics-window";
const WINDOWS: MetricsWindow[] = ["1h", "24h", "7d", "30d"];
const BUCKET: Record<MetricsWindow, string> = {
  "1h": "15m",
  "24h": "1h",
  "7d": "6h",
  "30d": "24h",
};
const BUCKET_MS: Record<string, number> = {
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "6h": 6 * 60 * 60_000,
  "24h": 24 * 60 * 60_000,
};

const OUTCOMES = [
  "COMPLETED",
  "FAILED",
  "REFUSED",
  "TIMED_OUT",
  "CANCELLED",
] as const;
const OUTCOME_HUES: Record<string, string> = {
  COMPLETED: "var(--hue-ok)",
  FAILED: "var(--hue-err)",
  REFUSED: "var(--hue-warn)",
  TIMED_OUT: "var(--hue-warn)",
  CANCELLED: "var(--text-faint)",
};
const DECISIONS = ["approved", "rejected", "expired", "superseded"] as const;
const DECISION_HUES: Record<string, string> = {
  approved: "var(--hue-ok)",
  rejected: "var(--hue-err)",
  expired: "var(--hue-warn)",
  superseded: "var(--hue-verify)",
};

function readWindow(): MetricsWindow {
  try {
    const value = localStorage.getItem(METRICS_WINDOW_KEY);
    return WINDOWS.includes(value as MetricsWindow)
      ? (value as MetricsWindow)
      : "24h";
  } catch {
    return "24h";
  }
}

const sum = (values: number[] | undefined) =>
  (values ?? []).reduce(
    (total, value) => total + (Number.isFinite(value) ? value : 0),
    0,
  );

const recordTotal = (record: Record<string, number[]> | undefined) =>
  Object.values(record ?? {}).reduce((total, values) => total + sum(values), 0);

export function metricsAreEmpty(data: MetricsView): boolean {
  const count =
    recordTotal(data.series["runs.outcomes"]) +
    sum(data.series["runs.started"]?.total) +
    recordTotal(data.series["spend.cost"]) +
    recordTotal(data.series["spend.tokens"]) +
    recordTotal(data.series["proposals.decisions"]) +
    recordTotal(data.series["events.intake"]) +
    sum(data.series["attempts.retries"]?.total);
  const latency = [
    ...(data.series["latency.queue_wait"]?.p50 ?? []),
    ...(data.series["latency.execution"]?.p50 ?? []),
    ...(data.series["proposals.time_to_decision"]?.p50 ?? []),
  ];
  return count === 0 && latency.every((value) => value == null);
}

function timeRange(data: MetricsView, index: number) {
  const from = data.buckets[index]!;
  const next = data.buckets[index + 1];
  const to =
    next ??
    new Date(Date.parse(from) + (BUCKET_MS[data.bucket] ?? 0)).toISOString();
  return { from, to };
}

function drilldown(
  view: "runs" | "proposals",
  data: MetricsView,
  index: number,
  values: Record<string, string | undefined>,
): string {
  const range = timeRange(data, index);
  const query = new URLSearchParams({ from: range.from, to: range.to });
  for (const [key, value] of Object.entries(values))
    if (value) query.set(key, value);
  return `#/${view}?${query.toString()}`;
}

function bucketLabel(iso: string, window: MetricsWindow) {
  const date = new Date(iso);
  return date.toLocaleString(undefined, {
    month: window === "30d" ? "short" : undefined,
    day: window === "7d" || window === "30d" ? "numeric" : undefined,
    hour:
      window === "1h" || window === "24h" || window === "7d"
        ? "numeric"
        : undefined,
    minute: window === "1h" ? "2-digit" : undefined,
  });
}

function duration(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "not enough samples";
  if (value < 1000) return `${Math.round(value)}ms`;
  if (value < 60_000)
    return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}s`;
  return `${(value / 60_000).toFixed(1)}m`;
}

function currency(value: number) {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);
}

function legend(
  items: Array<{ label: string; value: number; hue: string }>,
  format = (value: number) => String(value),
) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-(--text-faint)">
      {items.map((item) => (
        <span key={item.label} className="inline-flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="size-2 rounded-xs"
            style={{ background: item.hue }}
          />
          {item.label}{" "}
          <span className="tabular-nums text-(--text-dim)">
            {format(item.value)}
          </span>
        </span>
      ))}
    </div>
  );
}

function Card({
  title,
  value,
  children,
}: {
  title: string;
  value?: string;
  children: React.ReactNode;
}) {
  return (
    <article className="min-w-0 rounded-lg border border-(--border) bg-(--surface-1) p-4">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h3 className="text-[12px] font-semibold text-(--text)">{title}</h3>
        {value && (
          <span className="mono tabular-nums text-(--text-dim)">{value}</span>
        )}
      </div>
      {children}
    </article>
  );
}

function TimeAxis({ data }: { data: MetricsView }) {
  if (data.buckets.length === 0) return null;
  const last = timeRange(data, data.buckets.length - 1).to;
  return (
    <div
      aria-hidden="true"
      className="mt-1 flex justify-between text-[11px] tabular-nums text-(--text-faint)"
    >
      <span>{bucketLabel(data.buckets[0]!, data.window)}</span>
      <span>{bucketLabel(last, data.window)}</span>
    </div>
  );
}

function BandChart({
  values,
  label,
  hue,
  linkForPoint,
}: {
  values: BandDatum[];
  label: string;
  hue: string;
  linkForPoint: (index: number, value: BandDatum) => ChartLink;
}) {
  if (!values.some((value) => value.p50 != null && value.p95 != null)) {
    return (
      <div
        role="status"
        className="flex h-40 items-center justify-center rounded-md border border-dashed border-(--border) bg-(--surface-0) px-4 text-center text-[12px] text-(--text-faint)"
      >
        Not enough samples in any bucket (five are required for percentiles).
      </div>
    );
  }
  return (
    <Band values={values} label={label} hue={hue} linkForPoint={linkForPoint} />
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section
      aria-labelledby={`metrics-${title.toLowerCase().replaceAll(" ", "-")}`}
      className="space-y-3"
    >
      <div>
        <h2
          id={`metrics-${title.toLowerCase().replaceAll(" ", "-")}`}
          className="display text-[15px] font-semibold"
        >
          {title}
        </h2>
        <p className="mt-0.5 text-[12px] text-(--text-faint)">{description}</p>
      </div>
      <div className="grid min-w-0 gap-3 xl:grid-cols-2">{children}</div>
    </section>
  );
}

function outcomeBars(data: MetricsView): StackedBarDatum[] {
  const series = data.series["runs.outcomes"] ?? {};
  return data.buckets.map((bucket, index) => ({
    key: bucket,
    label: bucketLabel(bucket, data.window),
    segments: OUTCOMES.map((state) => {
      const value = series[state]?.[index] ?? 0;
      return {
        key: state,
        label: state.toLowerCase(),
        value,
        hue: OUTCOME_HUES[state],
        link:
          value > 0
            ? {
                href: drilldown("runs", data, index, {
                  population: "terminal",
                  state,
                }),
                label: `${value} ${state.toLowerCase()} run${value === 1 ? "" : "s"} in ${bucketLabel(bucket, data.window)}`,
              }
            : null,
      };
    }),
  }));
}

function decisionBars(data: MetricsView): StackedBarDatum[] {
  const series = data.series["proposals.decisions"] ?? {};
  return data.buckets.map((bucket, index) => ({
    key: bucket,
    label: bucketLabel(bucket, data.window),
    segments: DECISIONS.map((status) => {
      const value = series[status]?.[index] ?? 0;
      return {
        key: status,
        label: status,
        value,
        hue: DECISION_HUES[status],
        link:
          value > 0
            ? {
                href: drilldown("proposals", data, index, {
                  population: "decision",
                  decisionStatus: status,
                }),
                label: `${value} ${status} proposal${value === 1 ? "" : "s"} in ${bucketLabel(bucket, data.window)}`,
              }
            : null,
      };
    }),
  }));
}

function spendBars(data: MetricsView): StackedBarDatum[] {
  const series = data.series["spend.cost"] ?? {};
  const agents = Object.keys(series).sort(
    (a, b) => sum(series[b]) - sum(series[a]),
  );
  const hues = [
    "var(--hue-info)",
    "var(--hue-verify)",
    "var(--hue-ok)",
    "var(--hue-warn)",
  ];
  return data.buckets.map((bucket, index) => ({
    key: bucket,
    label: bucketLabel(bucket, data.window),
    segments: agents.map((agent, agentIndex) => {
      const value = series[agent]?.[index] ?? 0;
      return {
        key: agent,
        label: agent,
        value,
        hue: hues[agentIndex % hues.length]!,
        link:
          value > 0
            ? {
                href: drilldown("runs", data, index, {
                  population: "usage",
                  agent,
                }),
                label: `${currency(value)} spent by ${agent} in ${bucketLabel(bucket, data.window)}`,
              }
            : null,
      };
    }),
  }));
}

function bandValues(
  data: MetricsView,
  key:
    "latency.queue_wait" | "latency.execution" | "proposals.time_to_decision",
): BandDatum[] {
  const series = data.series[key];
  return data.buckets.map((_, index) => ({
    p50: series?.p50?.[index] ?? null,
    p95: series?.p95?.[index] ?? null,
  }));
}

function runBandLink(
  data: MetricsView,
  population: "leased" | "finished",
  noun: string,
) {
  return (index: number, value: BandDatum): ChartLink => ({
    href: drilldown("runs", data, index, { population }),
    label: `${noun} in ${bucketLabel(data.buckets[index]!, data.window)}: p50 ${duration(value.p50)}, p95 ${duration(value.p95)}`,
  });
}

export function Metrics() {
  const [window, setWindow] = useState<MetricsWindow>(readWindow);
  const bucket = BUCKET[window];
  const query = useQuery({
    queryKey: ["metrics", window, bucket],
    queryFn: () => fetchMetrics(window, bucket),
    refetchInterval: 30_000,
    retry: false,
  });

  useEffect(() => {
    try {
      localStorage.setItem(METRICS_WINDOW_KEY, window);
    } catch {
      // Private mode / quota: the selector still works for this load.
    }
  }, [window]);

  const data = query.data;
  const derived = useMemo(() => {
    if (!data) return null;
    const outcomes = OUTCOMES.map((state) => ({
      label: state.toLowerCase(),
      value: sum(data.series["runs.outcomes"]?.[state]),
      hue: OUTCOME_HUES[state],
    }));
    const decisions = DECISIONS.map((status) => ({
      label: status,
      value: sum(data.series["proposals.decisions"]?.[status]),
      hue: DECISION_HUES[status],
    }));
    const started = sum(data.series["runs.started"]?.total);
    const retries = sum(data.series["attempts.retries"]?.total);
    const retryRate = data.buckets.map((_, index) => {
      const denominator = data.series["runs.started"]?.total?.[index] ?? 0;
      const numerator = data.series["attempts.retries"]?.total?.[index] ?? 0;
      return denominator === 0 ? 0 : (numerator / denominator) * 100;
    });
    const tokens = data.buckets.map((_, index) =>
      Object.values(data.series["spend.tokens"] ?? {}).reduce(
        (total, values) => total + (values[index] ?? 0),
        0,
      ),
    );
    const agents = Object.entries(data.series["spend.cost"] ?? {})
      .map(([agent, values]) => ({
        label: agent,
        value: sum(values),
      }))
      .sort((a, b) => b.value - a.value)
      .map((item, index) => ({
        ...item,
        hue: [
          "var(--hue-info)",
          "var(--hue-verify)",
          "var(--hue-ok)",
          "var(--hue-warn)",
        ][index % 4]!,
      }));
    return { outcomes, decisions, started, retries, retryRate, tokens, agents };
  }, [data]);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-7xl space-y-7 p-5 pb-12">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="display text-h1 font-semibold">Metrics</h1>
            <p className="mt-1 text-[12px] text-(--text-faint)">
              Historical reliability, latency, spend, and approval decisions ·
              factory-wide
            </p>
          </div>
          <div
            role="group"
            aria-label="Metrics window"
            className="flex rounded-md border border-(--border) bg-(--surface-1) p-0.5"
          >
            {WINDOWS.map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={window === value}
                onClick={() => setWindow(value)}
                className={`rounded px-2.5 py-1 text-[12px] font-medium ${window === value ? "bg-(--surface-3) text-(--text)" : "text-(--text-faint) hover:text-(--text)"}`}
              >
                {value}
              </button>
            ))}
          </div>
        </header>

        {query.isPending ? (
          <div
            role="status"
            className="rounded-lg border border-(--border) bg-(--surface-1) p-5 text-(--text-faint)"
          >
            Loading metrics…
          </div>
        ) : query.isError ? (
          <div
            role="alert"
            className="rounded-lg border p-5"
            style={{
              color: "var(--hue-err)",
              borderColor:
                "color-mix(in oklch, var(--hue-err) 35%, var(--border))",
            }}
          >
            <div className="font-medium">Metrics API unreachable</div>
            <p className="mt-1 text-[12px]">
              No chart is shown because this is not evidence of an empty window.
            </p>
            <button
              type="button"
              onClick={() => query.refetch()}
              className="mt-3 rounded-md border border-current px-2.5 py-1 text-[12px]"
            >
              Retry
            </button>
          </div>
        ) : data && metricsAreEmpty(data) ? (
          <div
            role="status"
            className="rounded-lg border border-(--border) bg-(--surface-1) p-5"
          >
            <div className="font-medium">
              No activity in this {window} window
            </div>
            <p className="mt-1 text-[12px] text-(--text-faint)">
              Charts are withheld rather than drawing a fake flat line. Choose a
              longer window to look further back.
            </p>
          </div>
        ) : data && derived ? (
          <>
            <Section
              title="Reliability"
              description="Terminal outcome mix and retries per run start. Every mark opens the exact bucket population."
            >
              <Card
                title="Outcome mix"
                value={`${derived.outcomes.reduce((total, item) => total + item.value, 0)} terminal`}
              >
                <StackedBars
                  bars={outcomeBars(data)}
                  label={`Outcome mix: ${derived.outcomes.map((item) => `${item.value} ${item.label}`).join(", ")}`}
                />
                <TimeAxis data={data} />
                {legend(derived.outcomes)}
              </Card>
              <Card
                title="Retry rate"
                value={
                  derived.started > 0
                    ? `${((derived.retries / derived.started) * 100).toFixed(1)}%`
                    : "—"
                }
              >
                <Sparkline
                  values={derived.retryRate}
                  label={`Retry rate by ${data.bucket} bucket; ${derived.retries} retries across ${derived.started} starts`}
                  hue="var(--hue-warn)"
                  linkForPoint={(index, value) => ({
                    href: drilldown("runs", data, index, {
                      population: "retried",
                    }),
                    label: `${value.toFixed(1)}% retry rate in ${bucketLabel(data.buckets[index]!, data.window)}`,
                  })}
                />
                <TimeAxis data={data} />
                <div className="mt-4">
                  <SegmentMeter
                    segments={[
                      {
                        key: "retry",
                        label: "Retries",
                        value: derived.retries,
                        hue: "var(--hue-warn)",
                      },
                      {
                        key: "first",
                        label: "First attempts",
                        value: Math.max(0, derived.started - derived.retries),
                        hue: "var(--hue-ok)",
                      },
                    ]}
                  />
                  <p className="mt-2 text-[11px] text-(--text-faint)">
                    {derived.retries} retries · {derived.started} run starts
                  </p>
                </div>
              </Card>
            </Section>

            <Section
              title="Latency"
              description="p50–p95 bands appear only where a bucket has at least five samples; gaps are never interpolated."
            >
              <Card
                title="Queue wait"
                value={duration(data.series["latency.queue_wait"]?.p50?.at(-1))}
              >
                <BandChart
                  values={bandValues(data, "latency.queue_wait")}
                  label="Queue wait latency band, p50 median to p95"
                  hue="var(--hue-info)"
                  linkForPoint={runBandLink(data, "leased", "Queue wait")}
                />
                <TimeAxis data={data} />
                <p className="mt-2 text-[11px] text-(--text-faint)">
                  Band p50 → p95 · null buckets remain visible gaps
                </p>
              </Card>
              <Card
                title="Execution"
                value={duration(data.series["latency.execution"]?.p50?.at(-1))}
              >
                <BandChart
                  values={bandValues(data, "latency.execution")}
                  label="Execution latency band, p50 median to p95"
                  hue="var(--hue-verify)"
                  linkForPoint={runBandLink(data, "finished", "Execution")}
                />
                <TimeAxis data={data} />
                <p className="mt-2 text-[11px] text-(--text-faint)">
                  Completed attempts, measured independently across retries
                </p>
              </Card>
            </Section>

            <Section
              title="Spend"
              description="Recorded cost and token volume by agent. Click through to runs with usage recorded in that bucket."
            >
              <Card
                title="Cost by agent"
                value={currency(
                  derived.agents.reduce((total, item) => total + item.value, 0),
                )}
              >
                <StackedBars
                  bars={spendBars(data)}
                  label={`Cost by agent: ${derived.agents.map((item) => `${item.label} ${currency(item.value)}`).join(", ") || "none"}`}
                />
                <TimeAxis data={data} />
                {legend(derived.agents, currency)}
              </Card>
              <Card
                title="Token volume"
                value={new Intl.NumberFormat().format(sum(derived.tokens))}
              >
                <Sparkline
                  values={derived.tokens}
                  label={`${new Intl.NumberFormat().format(sum(derived.tokens))} recorded tokens across the window`}
                  hue="var(--hue-info)"
                  linkForPoint={(index, value) => ({
                    href: drilldown("runs", data, index, {
                      population: "usage",
                    }),
                    label: `${new Intl.NumberFormat().format(value)} tokens in ${bucketLabel(data.buckets[index]!, data.window)}`,
                  })}
                />
                <TimeAxis data={data} />
                <p className="mt-4 text-[11px] text-(--text-faint)">
                  Input, output, cache creation, and cache-read tokens recorded
                  by the runtime
                </p>
              </Card>
            </Section>

            <Section
              title="Approval gate"
              description="Time to a human or policy decision and the resulting decision mix."
            >
              <Card
                title="Time to decision"
                value={duration(
                  data.series["proposals.time_to_decision"]?.p50?.at(-1),
                )}
              >
                <BandChart
                  values={bandValues(data, "proposals.time_to_decision")}
                  label="Proposal time-to-decision band, p50 median to p95"
                  hue="var(--hue-warn)"
                  linkForPoint={(index, value) => ({
                    href: drilldown("proposals", data, index, {
                      population: "decision",
                    }),
                    label: `Proposal decisions in ${bucketLabel(data.buckets[index]!, data.window)}: p50 ${duration(value.p50)}, p95 ${duration(value.p95)}`,
                  })}
                />
                <TimeAxis data={data} />
                <p className="mt-2 text-[11px] text-(--text-faint)">
                  From proposal creation to recorded decision
                </p>
              </Card>
              <Card
                title="Decision mix"
                value={`${derived.decisions.reduce((total, item) => total + item.value, 0)} decisions`}
              >
                <StackedBars
                  bars={decisionBars(data)}
                  label={`Decision mix: ${derived.decisions.map((item) => `${item.value} ${item.label}`).join(", ")}`}
                />
                <TimeAxis data={data} />
                {legend(derived.decisions)}
              </Card>
            </Section>
          </>
        ) : null}
      </div>
    </div>
  );
}
