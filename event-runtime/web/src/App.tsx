import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { eventsHash, hashPath, hashSearch } from "./hash";
import { keyGuard, useHashRoute, useTheme } from "./hooks";
import type { EventFocus } from "./types";
import { CommandPalette, useGoSequences, type PaletteAction } from "./components/CommandPalette";
import { InjectDialog } from "./components/InjectDialog";
import { ShortcutsDialog } from "./components/ShortcutsDialog";
import { ToastContainer, copyLink, copyText } from "./components/ui";
import { Agents } from "./views/Agents";
import { Events } from "./views/Events";
import { Graph } from "./views/Graph";
import { Overview } from "./views/Overview";
import { Proposals } from "./views/Proposals";
import { Runs } from "./views/Runs";

// Agents rides `g t` ("what is this agent?"): o/e/p/r are taken, and `g a`
// would double-fire the proposals view's `a` (approve) list key — chord
// suffixes must never collide with single-key verbs.
const NAV = [
  { key: "overview", label: "Overview", go: "o" },
  { key: "events", label: "Events", go: "e" },
  { key: "proposals", label: "Proposals", go: "p" },
  { key: "runs", label: "Runs", go: "r" },
  { key: "agents", label: "Agents", go: "t" },
  { key: "graph", label: "Graph", go: "g" },
] as const;

export function App() {
  const [route, navigate] = useHashRoute();
  const view = route[0];
  const [, cycleTheme] = useTheme();
  const [injectOpen, setInjectOpen] = useState(false);
  const [injectSeed, setInjectSeed] = useState<Record<string, unknown> | undefined>(undefined);
  const [helpOpen, setHelpOpen] = useState(false);
  const [focusRunState, setFocusRunState] = useState<string | null>(null);
  const [focusExpired, setFocusExpired] = useState(false);
  const [ephemeralEvent, setEphemeralEvent] = useState<EventFocus | null>(null);
  const [filterFocus, setFilterFocus] = useState(false);

  const focusRunId = view === "runs" ? (route[1] ?? null) : null;
  const focusProposalId = view === "proposals" ? (route[1] ?? null) : null;
  const focusAgentRef = view === "agents" ? (route[1] ?? null) : null;
  const focusGraphNode = view === "graph" ? (route[1] ?? null) : null;
  const hashEvent: EventFocus | null =
    view === "events" && route[1] && route[2]
      ? { source: route[1], eventId: route[2] }
      : null;
  const typeFromHash = view === "events" ? hashSearch(window.location.hash).get("type") : null;
  const focusEvent =
    view === "events"
      ? {
          ...(ephemeralEvent ?? {}),
          ...(typeFromHash ? { type: typeFromHash } : {}),
          ...(hashEvent ?? {}),
        }
      : null;
  const hasEventFocus =
    !!(focusEvent && (focusEvent.source || focusEvent.eventId || focusEvent.status || focusEvent.type));

  const jumpToRun = (runId: string) => navigate(hashPath("runs", runId));
  const jumpToRuns = (state?: string) => {
    if (state) setFocusRunState(state);
    navigate("runs");
  };
  const jumpToProposal = (id: string) => navigate(hashPath("proposals", id));
  const jumpToEvent = (source: string, eventId: string, status?: string) => {
    setEphemeralEvent(status ? { status } : null);
    navigate(hashPath("events", source, eventId));
  };
  const jumpToEvents = (focus: EventFocus) => {
    if (focus.source && focus.eventId) {
      setEphemeralEvent(focus.status || focus.type ? { status: focus.status, type: focus.type } : null);
      navigate(hashPath("events", focus.source, focus.eventId));
      return;
    }
    if (focus.type) {
      setEphemeralEvent(focus.status ? { status: focus.status } : null);
      navigate(eventsHash(null, null, focus.type));
      return;
    }
    setEphemeralEvent(focus);
    navigate("events");
  };
  const jumpToAgent = (ref: string) => navigate(hashPath("agents", ref));
  const jumpToGraph = (nodeId?: string) => navigate(hashPath("graph", nodeId));

  const health = useQuery({
    queryKey: ["health"],
    queryFn: api.health,
    refetchInterval: 2000,
    retry: false,
  });
  const connected = health.isSuccess;
  // Banner only after a failed fetch — first-load pending must not flash
  // "unreachable" over an empty factory.
  const healthFailed = !connected && !health.isPending;

  const status = useQuery({ queryKey: ["status"], queryFn: api.status, refetchInterval: 2000 });
  const openProposals = status.data?.proposals.open ?? 0;
  const activeRuns = Object.entries(status.data?.runs.byState ?? {})
    .filter(([s]) => ["QUEUED", "LEASED", "RUNNING", "VERIFYING"].includes(s))
    .reduce((sum, [, n]) => sum + (n ?? 0), 0);
  const eventAttention =
    (status.data?.events.human_needed ?? 0) + (status.data?.events.dead_lettered ?? 0);

  const env = health.data?.env;
  const envHue = !connected
    ? "var(--hue-err)"
    : env?.name === "live"
      ? "var(--hue-warn)"
      : "var(--hue-info)";
  const envLabel = !connected
    ? "disconnected"
    : env
      ? env.adapter
        ? `${env.name} · ${env.adapter}`
        : env.name
      : "…";

  useGoSequences(
    useMemo(
      () => Object.fromEntries(NAV.map((n) => [n.go, () => navigate(n.key)])),
      [navigate],
    ),
  );

  useEffect(() => {
    const nav = NAV.find((n) => n.key === view);
    const label = nav?.label ?? "Overview";
    const id = route.length > 1 ? route[route.length - 1] : null;
    const typeQ = hashSearch(window.location.hash).get("type");
    const detail = id ?? typeQ;
    document.title = detail ? `factory · ${label} · ${detail}` : `factory · ${label}`;
  }, [route, view]);

  useEffect(() => {
    if (!filterFocus) return;
    const el = document.querySelector<HTMLInputElement>("[data-view-filter]");
    if (!el) return;
    el.focus();
    setFilterFocus(false);
  }, [filterFocus, view]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (keyGuard(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "i") {
        e.preventDefault();
        setInjectOpen(true);
      } else if (e.key === "?") {
        e.preventDefault();
        setHelpOpen((open) => !open);
      } else if (e.key === "/") {
        e.preventDefault();
        const el = document.querySelector<HTMLInputElement>("[data-view-filter]");
        if (el) el.focus();
        else {
          setFilterFocus(true);
          navigate("events");
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate]);

  const paletteActions: PaletteAction[] = [
    ...NAV.map((n) => ({
      label: `Go to ${n.label}`,
      hint: `g ${n.go}`,
      group: "Go" as const,
      run: () => navigate(n.key),
    })),
    { label: "Inject event…", hint: "i", run: () => setInjectOpen(true) },
    {
      label: "Focus filter",
      hint: "/",
      run: () => {
        const el = document.querySelector<HTMLInputElement>("[data-view-filter]");
        if (el) el.focus();
        else {
          setFilterFocus(true);
          navigate("events");
        }
      },
    },
    { label: "Copy link to this page", run: copyLink },
    { label: "Keyboard shortcuts", hint: "?", run: () => setHelpOpen(true) },
    { label: "Cycle theme (dark → light → contrast)", run: cycleTheme },
  ];

  return (
    <div className="flex h-screen">
      <nav className="flex w-52 shrink-0 flex-col border-r border-(--border) bg-(--surface-1)">
        <div className="flex items-center justify-between gap-2 px-4 pt-4 pb-3">
          <div className="flex items-center gap-2">
            <img src="/watt-mind-logo.svg" alt="Watt Mind" className="size-5.5 shrink-0" />
            <span className="display text-[14px] font-semibold">factory</span>
          </div>
          <button
            type="button"
            className="rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wide uppercase"
            title={
              env
                ? `${env.home} · policy ${health.data?.policyVersion} — click to copy home`
                : "runtime unreachable"
            }
            style={{
              color: envHue,
              background: `color-mix(in oklch, ${envHue} 15%, transparent)`,
            }}
            onClick={() => env?.home && copyText(env.home, "runtime home")}
          >
            {envLabel}
          </button>
        </div>
        <div className="flex-1 px-2">
          {NAV.map((n) => {
            const count =
              n.key === "proposals"
                ? openProposals
                : n.key === "runs"
                  ? activeRuns
                  : n.key === "events"
                    ? eventAttention
                    : 0;
            return (
              <button
                key={n.key}
                type="button"
                aria-current={view === n.key ? "page" : undefined}
                onClick={() => navigate(n.key)}
                className={`flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left text-[13px] ${
                  view === n.key
                    ? "bg-(--surface-3) font-medium text-(--text)"
                    : "text-(--text-dim) hover:bg-(--surface-2)"
                }`}
              >
                <span>{n.label}</span>
                {count > 0 && (
                  <span
                    className="rounded px-1.5 text-[11px] tabular-nums"
                    style={{
                      color: "var(--accent)",
                      background: "color-mix(in oklch, var(--accent) 14%, transparent)",
                    }}
                  >
                    {count}
                  </span>
                )}
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => setInjectOpen(true)}
            className="mt-2 w-full rounded-md px-2.5 py-1.5 text-left text-[13px] text-(--text-dim) hover:bg-(--surface-2)"
          >
            Inject event… <span className="mono ml-1 text-(--text-faint)">i</span>
          </button>
        </div>
        <div className="border-t border-(--border) px-4 py-3 text-[11px]">
          <div className="flex items-center gap-2">
            <span
              className="size-2 rounded-full"
              style={{ background: connected ? "var(--hue-ok)" : "var(--hue-err)" }}
            />
            {connected ? (
              <span className="text-(--text-dim)">
                connected · <span className="mono">{health.data?.policyVersion}</span>
              </span>
            ) : (
              <span style={{ color: "var(--hue-err)" }}>runtime unreachable</span>
            )}
          </div>
          <div className="mt-1.5 text-(--text-faint)">
            <span className="mono">⌘K</span> commands · <span className="mono">g</span>+
            <span className="mono">o/e/p/r/t/g</span> · <span className="mono">/</span> filter ·{" "}
            <span className="mono">i</span> inject · <span className="mono">?</span> keys
          </div>
        </div>
      </nav>

      <main className="flex min-w-0 flex-1 flex-col">
        {healthFailed && (
          <div
            role="status"
            className="shrink-0 border-b px-4 py-2 text-[12px]"
            style={{
              color: "var(--hue-err)",
              background: "color-mix(in oklch, var(--hue-err) 10%, transparent)",
              borderColor: "color-mix(in oklch, var(--hue-err) 35%, var(--border))",
            }}
          >
            <div className="flex items-center justify-between gap-3">
              <span>
                Runtime unreachable — lists show last cached data; verbs are disabled until{" "}
                <span className="mono">/health</span> responds. This is not an empty factory.
              </span>
              <button
                type="button"
                onClick={() => health.refetch()}
                className="shrink-0 rounded-md border px-2 py-0.5 text-[11px] font-medium"
                style={{
                  color: "var(--hue-err)",
                  borderColor: "color-mix(in oklch, var(--hue-err) 40%, var(--border))",
                }}
              >
                Retry
              </button>
            </div>
          </div>
        )}
        <div className="min-h-0 flex-1">
          {view === "proposals" ? (
            <Proposals
              connected={connected}
              onRunQueued={jumpToRun}
              focusProposalId={focusProposalId}
              onSelectProposal={(id) => navigate(hashPath("proposals", id))}
              focusExpired={focusExpired}
              onFocusExpiredConsumed={() => setFocusExpired(false)}
              onJumpAgent={jumpToAgent}
              onJumpEvent={jumpToEvent}
            />
          ) : view === "runs" ? (
            <Runs
              connected={connected}
              focusRunId={focusRunId}
              onSelectRun={(id) => navigate(hashPath("runs", id))}
              focusState={focusRunState}
              onFocusStateConsumed={() => setFocusRunState(null)}
              onJumpAgent={jumpToAgent}
              onJumpEvent={jumpToEvent}
            />
          ) : view === "graph" ? (
            <Graph
              focusNodeId={focusGraphNode}
              onSelectNode={(id) => navigate(hashPath("graph", id))}
              onJumpAgent={jumpToAgent}
              onJumpEvents={jumpToEvents}
            />
          ) : view === "agents" ? (
            <Agents
              focusAgentRef={focusAgentRef}
              onSelectAgent={(ref) => navigate(hashPath("agents", ref))}
            />
          ) : view === "events" ? (
            <Events
              connected={connected}
              focusEvent={hasEventFocus ? focusEvent : null}
              onFocusConsumed={() => setEphemeralEvent(null)}
              onSelectEvent={(source, eventId) =>
                navigate(eventsHash(source, eventId, typeFromHash))
              }
              onSelectType={(type) =>
                navigate(eventsHash(hashEvent?.source, hashEvent?.eventId, type))
              }
              onJumpProposal={jumpToProposal}
              onJumpRun={jumpToRun}
              onTriggerAgain={(envelope) => {
                setInjectSeed(envelope);
                setInjectOpen(true);
              }}
              onInject={() => setInjectOpen(true)}
            />
          ) : (
            <Overview
              connected={connected}
              onJumpRun={jumpToRun}
              onJumpProposal={jumpToProposal}
              onJumpEvents={jumpToEvents}
              onJumpRuns={jumpToRuns}
              onNavigate={navigate}
              onJumpExpired={() => {
                setFocusExpired(true);
                navigate("proposals");
              }}
              onJumpGraph={() => jumpToGraph()}
              onInject={() => setInjectOpen(true)}
            />
          )}
        </div>
      </main>

      <CommandPalette
        actions={paletteActions}
        onJumpRun={jumpToRun}
        onJumpProposal={jumpToProposal}
        onJumpEvent={jumpToEvent}
        onJumpAgent={jumpToAgent}
      />
      {injectOpen && (
        <InjectDialog
          initialEnvelope={injectSeed}
          onClose={() => {
            setInjectOpen(false);
            setInjectSeed(undefined);
          }}
          onAdmitted={(source, eventId) => {
            setInjectOpen(false);
            setInjectSeed(undefined);
            jumpToEvent(source, eventId);
          }}
        />
      )}
      {helpOpen && <ShortcutsDialog onClose={() => setHelpOpen(false)} />}
      <ToastContainer />
    </div>
  );
}
