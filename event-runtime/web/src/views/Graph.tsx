import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  type Edge,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { keyGuard } from "../hooks";
import { buildCapabilityGraph, type GraphNode } from "../graph/model";
import { layoutGraph, NODE_HEIGHT, NODE_WIDTH } from "../graph/layout";
import { nodeTypes } from "../graph/nodes";
import type { EventFocus } from "../types";
import { Button, JsonBlock, JumpLink, KV, Section, copyText, copyLink } from "../components/ui";

/**
 * Graph (webui roadmap / OPS-224 phase 1, chrome OPS-230): the capability map
 * — what this runtime *can* do, drawn from the registry alone. Same inverted-L
 * as the list views: canvas + right detail, jumps to Events/Agents, Copy id,
 * honest empty when /agents is down. Phase 2 overlays live run state.
 */
export function Graph({
  focusNodeId,
  onSelectNode,
  onJumpAgent,
  onJumpEvents,
}: {
  focusNodeId: string | null;
  onSelectNode: (id: string | null) => void;
  onJumpAgent: (ref: string) => void;
  onJumpEvents: (focus: EventFocus) => void;
}) {
  const registry = useQuery({ queryKey: ["agents"], queryFn: api.agents, refetchInterval: 10_000 });
  const [positioned, setPositioned] = useState<{ nodes: Node[]; edges: Edge[] } | null>(null);
  const flowRef = useRef<{
    getZoom: () => number;
    fitView: (opts: {
      nodes?: Array<{ id: string }>;
      padding?: number;
      duration?: number;
      minZoom?: number;
      maxZoom?: number;
    }) => void;
  } | null>(null);
  const [flowReady, setFlowReady] = useState(0);

  const graph = useMemo(
    () => (registry.data ? buildCapabilityGraph(registry.data) : null),
    [registry.data],
  );

  useEffect(() => {
    if (!graph) return;
    let cancelled = false;
    layoutGraph(graph).then((positions) => {
      if (cancelled) return;
      setPositioned({
        nodes: graph.nodes.map((node) => ({
          id: node.id,
          type: node.kind,
          position: positions.get(node.id) ?? { x: 0, y: 0 },
          data: { node },
          draggable: true,
          width: NODE_WIDTH,
          height: NODE_HEIGHT,
        })),
        edges: graph.edges.map((edge) => ({
          id: edge.id,
          source: edge.source,
          target: edge.target,
          label: edge.label,
          animated: false,
          style: {
            stroke: edge.kind === "recommends" ? "var(--accent)" : "var(--border-strong)",
            strokeWidth: 1.5,
            strokeDasharray: edge.kind === "recommends" ? "4 3" : undefined,
          },
          labelStyle: { fill: "var(--text-faint)", fontSize: 10 },
          labelBgStyle: { fill: "var(--surface-0)" },
        })),
      });
    });
    return () => {
      cancelled = true;
    };
  }, [graph]);

  const nodes = useMemo(
    () => (positioned ? positioned.nodes.map((n) => ({ ...n, selected: n.id === focusNodeId })) : []),
    [positioned, focusNodeId],
  );

  const selected: GraphNode | undefined = graph?.nodes.find((n) => n.id === focusNodeId);
  const agentDef =
    selected?.kind === "agent"
      ? registry.data?.agents.find((a) => a.ref === selected.label)
      : undefined;

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (keyGuard(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Escape") {
        onSelectNode(null);
        return;
      }
      if (e.key === "c" && focusNodeId) {
        e.preventDefault();
        const node = graph?.nodes.find((n) => n.id === focusNodeId);
        if (node) copyText(node.label, node.kind === "agent" ? "agent ref" : "id");
        return;
      }
      const order = positioned
        ? [...positioned.nodes]
            .sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x)
            .map((n) => n.id)
        : (graph?.nodes.map((n) => n.id) ?? []);
      if (!order.length) return;
      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        const idx = focusNodeId ? order.indexOf(focusNodeId) : -1;
        onSelectNode(order[Math.min(idx + 1, order.length - 1)]);
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        const idx = focusNodeId ? order.indexOf(focusNodeId) : order.length;
        onSelectNode(order[Math.max(idx - 1, 0)]);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onSelectNode, focusNodeId, graph, positioned]);

  useEffect(() => {
    if (!focusNodeId || !flowRef.current) return;
    const zoom = flowRef.current.getZoom();
    flowRef.current.fitView({
      nodes: [{ id: focusNodeId }],
      padding: 0.45,
      duration: 180,
      minZoom: zoom,
      maxZoom: zoom,
    });
  }, [focusNodeId, flowReady, positioned]);

  const emptyCopy = registry.isPending
    ? "Loading the capability map…"
    : registry.isError
      ? "Cannot reach the control API — the graph will appear when /agents is up."
      : graph && graph.nodes.length === 0
        ? "No registered event types or agents."
        : "Laying out the capability map…";

  return (
    <div className="flex h-full min-w-0">
      <div className="relative min-w-0 flex-1">
        <div className="absolute top-4 left-5 z-10">
          <h1 className="display text-lg font-semibold">Graph</h1>
          <div className="text-[11px] text-(--text-faint)">
            what this runtime can do — registered routes and recommendation edges
          </div>
        </div>
        {positioned && graph && graph.nodes.length > 0 ? (
          <ReactFlow
            nodes={nodes}
            edges={positioned.edges}
            nodeTypes={nodeTypes}
            onNodeClick={(_, node) => onSelectNode(node.id)}
            onPaneClick={() => onSelectNode(null)}
            onInit={(inst) => {
              flowRef.current = inst;
              setFlowReady((n) => n + 1);
            }}
            nodesFocusable
            fitView
            fitViewOptions={{ padding: 0.25 }}
            proOptions={{ hideAttribution: true }}
            minZoom={0.2}
          >
            <Background color="var(--border)" gap={20} size={1} />
            <Controls
              showInteractive={false}
              style={{ background: "var(--surface-1)", border: "1px solid var(--border)" }}
            />
            {/* Minimap paints into SVG where var()/color-mix do not resolve —
                style its nodes by class instead (see theme.css). */}
            <MiniMap
              pannable
              zoomable
              style={{ background: "var(--surface-1)", border: "1px solid var(--border)" }}
              maskColor="rgba(0, 0, 0, 0.55)"
              nodeClassName={(n) => `minimap-node minimap-${n.type}`}
            />
          </ReactFlow>
        ) : (
          <div className="flex h-full items-center justify-center px-8 text-center text-(--text-faint)">
            {emptyCopy}
          </div>
        )}
      </div>

      {selected && (
        <div className="w-[420px] shrink-0 overflow-auto border-l border-(--border) bg-(--surface-1) p-4">
          <div className="mb-3 flex items-center justify-between gap-2">
            <div className="display truncate text-[14px] font-semibold">{selected.label}</div>
            <div className="flex shrink-0 gap-1.5">
              <Button onClick={() => copyText(selected.label, selected.kind === "agent" ? "agent ref" : "id")}>
                {selected.kind === "agent" ? "Copy ref" : "Copy id"}
              </Button>
              <Button onClick={copyLink}>Copy link</Button>
              <Button onClick={() => onSelectNode(null)}>Close</Button>
            </div>
          </div>

          {selected.kind === "eventType" && (
            <>
              <Section title="Event type">
                <KV k="type" v={selected.label} />
                <KV k="adapter" v={selected.adapter} />
                <KV k="idempotency scope" v={selected.scope.join(" + ") || "—"} />
                <KV k="proposal ttl" v={selected.ttl ? `${selected.ttl}s` : "—"} />
              </Section>
              <Button onClick={() => onJumpEvents({ type: selected.label })}>
                Show in Events
              </Button>
            </>
          )}

          {selected.kind === "terminal" && (
            <Section title="Terminal">
              <div className="text-[12px] text-(--text-dim)">
                Recommendation values with no registered edge: <span className="mono">{selected.reason}</span>. A
                run that returns one of these completes and chains no further.
              </div>
            </Section>
          )}

          {selected.kind === "agent" && agentDef && (
            <>
              <Section title="Agent">
                <KV
                  k="ref"
                  v={
                    <JumpLink onClick={() => onJumpAgent(agentDef.ref)} title="Open in Agents">
                      {agentDef.ref}
                    </JumpLink>
                  }
                />
                <KV k="execution" v={selected.execution} />
                <KV k="output contract" v={agentDef.outputContract} />
                <KV k="mutating" v={agentDef.mutating ? "yes" : "no"} />
                <KV k="capabilities" v={agentDef.capabilities?.services?.join(", ") ?? "—"} />
                <KV k="timeout" v={`${agentDef.limits?.timeout_seconds ?? "—"}s`} />
                <KV k="attempts" v={String(agentDef.limits?.attempts ?? "—")} />
              </Section>
              {agentDef.command && (
                <Section title="Closed command template">
                  <JsonBlock value={agentDef.command} />
                </Section>
              )}
              {agentDef.actionRegistry && (
                <Section title={`Closed action registry · hosts ${agentDef.hosts?.join(", ")}`}>
                  <JsonBlock value={agentDef.actionRegistry} />
                </Section>
              )}
              <Section title="Prompt">
                <pre className="mono max-h-64 overflow-auto rounded-md border border-(--border) bg-(--surface-0) p-3 whitespace-pre-wrap">
                  {agentDef.prompt}
                </pre>
              </Section>
              <Button onClick={() => onJumpAgent(agentDef.ref)}>Open in Agents</Button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
