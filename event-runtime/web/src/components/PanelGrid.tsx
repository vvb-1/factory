/**
 * PanelGrid — declarative Overview panels (`factory.panel-view/v1`, WM-840,
 * docs/event-runtime-artifact-views.md §2.6).
 *
 * The runtime serves the catalogue at `GET /panels`: each panel names an
 * allow-listed loopback GET route, a query, an RFC 6901 pointer into the
 * response and an artifact-view body. This component fetches the catalogue,
 * then each panel's source on its own TanStack Query at the panel's
 * `refreshSeconds`, selects the node and draws it with `ArtifactView` — the
 * same renderer agents' artifacts use, so a pack or extension gets a
 * dashboard tile without shipping React.
 *
 * Isolation is the whole point of the grid: every tile has its own query and
 * its own error boundary, so one panel whose endpoint fails, whose pointer
 * misses, or whose data trips the renderer shows an inline error tile and
 * never takes the grid — or Overview — with it. Zero panels renders nothing
 * (no empty section), so a stock install without panels looks as it did.
 */
import { useQuery } from "@tanstack/react-query";
import { Component, useMemo, type ErrorInfo, type ReactNode } from "react";
import { api, type PanelView } from "../api";
import { resolvePointer, sectionsFor, viewApplies } from "../lib/artifactView";
import type { ArtifactView as ArtifactViewDoc } from "../types";
import { ArtifactView } from "./ArtifactView";
import { Button } from "./ui";

/** How often the catalogue itself is re-read; panels change at serve start, not per tick. */
const CATALOGUE_REFRESH_MS = 60_000;

const errorMessage = (error: unknown): string =>
  error instanceof Error && error.message
    ? error.message
    : typeof error === "string"
      ? error
      : "request failed";

/**
 * The tile frame every state shares: title, origin, a right-aligned slot,
 * then the body. `data-panel` carries the panel name for tests and styling.
 */
function PanelTile({
  panel,
  aside,
  children,
}: {
  panel: PanelView;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      data-panel={panel.name}
      className="flex min-w-0 flex-col rounded-lg border border-(--border) bg-(--surface-1) p-3.5"
    >
      <div className="mb-2 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span
          className="text-[12px] font-medium text-(--text)"
          title={panel.description ?? undefined}
        >
          {panel.title}
        </span>
        <span
          className="text-[10.5px] text-(--text-faint)"
          title={`${panel.file} · ${panel.source.endpoint}`}
        >
          {panel.origin}
        </span>
        {aside && <span className="ml-auto">{aside}</span>}
      </div>
      {/* Long tables scroll inside the tile so one busy panel cannot stretch the whole grid row. */}
      <div className="max-h-[24rem] min-w-0 overflow-auto">{children}</div>
    </div>
  );
}

function TileNote({ children }: { children: ReactNode }) {
  return <p className="m-0 text-[12px] text-(--text-faint)">{children}</p>;
}

/** The inline error tile: what went wrong and a way to try again, nothing more. */
function TileError({
  panel,
  message,
  onRetry,
}: {
  panel: PanelView;
  message: string;
  onRetry?: () => void;
}) {
  return (
    <PanelTile
      panel={panel}
      aside={
        onRetry && (
          <Button size="sm" variant="ghost" onClick={onRetry}>
            Retry
          </Button>
        )
      }
    >
      <div
        role="alert"
        className="rounded-md px-2.5 py-1.5 text-[12px]"
        style={{
          color: "var(--hue-err)",
          background: "color-mix(in oklch, var(--hue-err) 10%, transparent)",
        }}
      >
        <span className="font-medium">Panel failed:</span> {message}
        <span className="ml-1 text-(--text-faint)">
          ({panel.source.endpoint})
        </span>
      </div>
    </PanelTile>
  );
}

/**
 * A render fault inside one tile stays inside that tile. The artifact-view
 * renderer degrades rather than throws, so this is a belt over braces — but
 * a third-party panel is exactly the input a belt is for.
 */
class TileBoundary extends Component<
  { panel: PanelView; children: ReactNode },
  { error: string | null }
> {
  state = { error: null as string | null };
  static getDerivedStateFromError(error: unknown) {
    return { error: errorMessage(error) };
  }
  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error(
      `panel ${this.props.panel.name} failed to render`,
      error,
      info,
    );
  }
  render() {
    if (this.state.error !== null) {
      return (
        <TileError
          panel={this.props.panel}
          message={`render error — ${this.state.error}`}
          onRetry={() => this.setState({ error: null })}
        />
      );
    }
    return this.props.children;
  }
}

/** One panel: its own query at its own cadence, the selected node drawn with ArtifactView. */
export function PanelBody({
  panel,
  allowed,
  onJumpRun,
}: {
  panel: PanelView;
  /** The runtime's endpoint allow-list; a panel outside it is refused client-side too. */
  allowed: string[];
  onJumpRun?: (runId: string) => void;
}) {
  const { endpoint, query, path } = panel.source;
  const permitted = allowed.includes(endpoint);
  const source = useQuery({
    queryKey: ["panel", panel.name, endpoint, query],
    queryFn: () => api.panelSource(endpoint, query),
    enabled: permitted,
    refetchInterval: Math.max(5, panel.refreshSeconds) * 1000,
    refetchIntervalInBackground: false,
    retry: false,
  });
  const view = useMemo<ArtifactViewDoc>(
    () => ({ schemaVersion: "factory.artifact-view/v1", ...panel.view }),
    [panel.view],
  );

  if (!permitted) {
    return (
      <TileError
        panel={panel}
        message={`endpoint ${endpoint} is not allow-listed`}
      />
    );
  }
  if (source.isError) {
    return (
      <TileError
        panel={panel}
        message={errorMessage(source.error)}
        onRetry={() => void source.refetch()}
      />
    );
  }
  if (source.data === undefined) {
    return (
      <PanelTile panel={panel}>
        <TileNote>Loading…</TileNote>
      </PanelTile>
    );
  }
  const node = resolvePointer(source.data, path);
  const refreshed = source.dataUpdatedAt
    ? new Date(source.dataUpdatedAt).toLocaleTimeString()
    : null;
  const aside = (
    <span
      className={`text-[10.5px] text-(--text-faint) ${source.isFetching ? "opacity-60" : ""}`}
      title={`refreshes every ${panel.refreshSeconds}s`}
    >
      {refreshed ? `as of ${refreshed}` : null}
    </span>
  );
  if (node === undefined) {
    return (
      <PanelTile panel={panel} aside={aside}>
        <TileNote>
          Nothing at <code>{path || '""'}</code> in {endpoint}.
        </TileNote>
      </PanelTile>
    );
  }
  if (Array.isArray(node) && node.length === 0) {
    return (
      <PanelTile panel={panel} aside={aside}>
        <TileNote>Nothing to show — empty.</TileNote>
      </PanelTile>
    );
  }
  // `viewApplies` gates on an object artifact (that is what agents emit); a
  // panel's node is often the array itself, so ask the sections directly then.
  const applies = Array.isArray(node)
    ? sectionsFor(view, node).length > 0
    : viewApplies(view, node);
  if (!applies) {
    return (
      <PanelTile panel={panel} aside={aside}>
        <TileNote>Nothing to show — the view matches no field here.</TileNote>
      </PanelTile>
    );
  }
  return (
    <PanelTile panel={panel} aside={aside}>
      <ArtifactView view={view} artifact={node} onJumpRun={onJumpRun} />
    </PanelTile>
  );
}

/**
 * The grid: reads `/panels`, renders one isolated tile per panel below the
 * host's own content, and renders nothing at all when there is no panel
 * (or the catalogue itself cannot be read — the host page is not the place
 * to report a missing optional feature; `/status` anomalies are).
 */
export function PanelGrid({
  onJumpRun,
}: {
  onJumpRun?: (runId: string) => void;
}) {
  const catalogue = useQuery({
    queryKey: ["panels"],
    queryFn: api.panels,
    staleTime: CATALOGUE_REFRESH_MS,
    refetchInterval: CATALOGUE_REFRESH_MS,
    refetchIntervalInBackground: false,
    retry: false,
  });
  const panels = catalogue.data?.panels ?? [];
  const allowed = catalogue.data?.endpoints ?? [];
  if (panels.length === 0) return null;
  return (
    <section aria-label="Panels" className="mb-5">
      <div className="mb-1.5 flex items-center gap-1.5">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-(--text-faint)">
          Panels
        </span>
        <span className="ml-auto text-right text-[11px] text-(--text-faint)">
          {panels.length === 1 ? "1 panel" : `${panels.length} panels`}
        </span>
      </div>
      {/*
        Columns size to content, not to a breakpoint: one panel takes the full
        width, three share it, and no tile is ever squeezed under ~22rem while
        an empty column sits beside it (UX critique, WM-840).
      */}
      <div
        className="grid gap-3"
        style={{
          gridTemplateColumns:
            "repeat(auto-fit, minmax(min(100%, 22rem), 1fr))",
        }}
      >
        {panels.map((panel) => (
          <TileBoundary key={panel.name} panel={panel}>
            <PanelBody panel={panel} allowed={allowed} onJumpRun={onJumpRun} />
          </TileBoundary>
        ))}
      </div>
    </section>
  );
}
