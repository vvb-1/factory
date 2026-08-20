import type {
  CapabilityGraph,
  GraphEdge,
  GraphNode,
  HistoricalOverlayValue,
} from "./model";

// The single source of truth for what node/edge colors and dashes *mean*
// (WM-99). Node components, edge mapping, and the legend all read from here,
// so the legend can never drift from what the canvas actually draws.

export type NodeStyleKey =
  "eventType" | "agentReadOnly" | "agentMutating" | "terminal" | "proposal";

export const NODE_STYLES: Record<
  NodeStyleKey,
  { label: string; accent: string; dashed: boolean }
> = {
  eventType: { label: "event type", accent: "var(--hue-info)", dashed: false },
  agentReadOnly: {
    label: "agent · read-only",
    accent: "var(--hue-ok)",
    dashed: false,
  },
  agentMutating: {
    label: "agent · mutating",
    accent: "var(--hue-warn)",
    dashed: false,
  },
  terminal: { label: "chain ends", accent: "var(--hue-idle)", dashed: true },
  proposal: {
    label: "pending proposal",
    accent: "var(--hue-info)",
    dashed: true,
  },
};

export const nodeStyleKey = (node: GraphNode): NodeStyleKey =>
  node.kind === "agent"
    ? node.mutating
      ? "agentMutating"
      : "agentReadOnly"
    : node.kind;

export const EDGE_STYLES: Record<
  GraphEdge["kind"],
  { label: string; stroke: string; strokeDasharray?: string }
> = {
  routes: { label: "routes to agent", stroke: "var(--border-strong)" },
  recommends: {
    label: "recommendation",
    stroke: "var(--accent)",
    strokeDasharray: "4 3",
  },
  proposal: {
    label: "pending execution",
    stroke: "var(--hue-info)",
    strokeDasharray: "3 3",
  },
};

const rampPct = (value: HistoricalOverlayValue) =>
  Math.round(Math.max(0, Math.min(1, value.intensity)) * 100);

/**
 * Floor and ceiling for a node *background* tint. Node body text stays on
 * `var(--text)`, so the hottest cell must still be a tint, not a fill —
 * theme.css tints rows at 6–14% for exactly this reason. 22% is the top of that
 * band: enough gradation from 5% to read as a ramp, dark enough in neither
 * theme to swallow near-black or near-white body text.
 */
const TINT_MIN_PCT = 5;
const TINT_MAX_PCT = 22;

/** Theme-token ramps resolve at paint time, so dark, light, and high-contrast
 * all use their own --accent/semantic hues rather than baked RGB values. */
export function historicalColor(value: HistoricalOverlayValue): string {
  if (value.noData) return "var(--surface-1)";
  const pct = rampPct(value);
  const tint =
    value.mode === "health"
      ? `color-mix(in oklch, var(--hue-err) ${pct}%, var(--hue-ok))`
      : "var(--accent)";
  const strength =
    TINT_MIN_PCT + Math.round((pct * (TINT_MAX_PCT - TINT_MIN_PCT)) / 100);
  return `color-mix(in oklch, ${tint} ${strength}%, var(--surface-1))`;
}

/**
 * The same ramp as a stroke. A 1.5px line carries no text, so it keeps full
 * saturation — capping it to the background tint would make edges invisible
 * against the canvas.
 */
export function historicalStroke(value: HistoricalOverlayValue): string {
  const pct = rampPct(value);
  return value.mode === "health"
    ? `color-mix(in oklch, var(--hue-err) ${pct}%, var(--hue-ok))`
    : `color-mix(in oklch, var(--accent) ${15 + Math.round(pct * 0.85)}%, var(--surface-1))`;
}

export function historicalRamp(graph: CapabilityGraph): {
  min: HistoricalOverlayValue;
  max: HistoricalOverlayValue;
} | null {
  const values = graph.nodes.flatMap((node) =>
    node.historical && !node.historical.noData ? [node.historical] : [],
  );
  if (values.length === 0) return null;
  return {
    min: values.reduce((a, b) => (b.value < a.value ? b : a)),
    max: values.reduce((a, b) => (b.value > a.value ? b : a)),
  };
}

export interface LegendEntries {
  nodes: Array<{ key: NodeStyleKey } & (typeof NODE_STYLES)[NodeStyleKey]>;
  edges: Array<
    { kind: GraphEdge["kind"] } & (typeof EDGE_STYLES)[GraphEdge["kind"]]
  >;
}

/**
 * Legend entries for the styles this graph actually uses — a map with no
 * mutating agents does not advertise the mutating color.
 */
export function legendEntries(graph: CapabilityGraph): LegendEntries {
  const usedNodes = new Set(graph.nodes.map(nodeStyleKey));
  const usedEdges = new Set(graph.edges.map((e) => e.kind));
  return {
    nodes: (Object.keys(NODE_STYLES) as NodeStyleKey[])
      .filter((key) => usedNodes.has(key))
      .map((key) => ({ key, ...NODE_STYLES[key] })),
    edges: (Object.keys(EDGE_STYLES) as GraphEdge["kind"][])
      .filter((kind) => usedEdges.has(kind))
      .map((kind) => ({ kind, ...EDGE_STYLES[kind] })),
  };
}
