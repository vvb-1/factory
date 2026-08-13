import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { eventsHash, hashPath, hashSearch } from "./hash";
import { keyGuard, useHashRoute, useTheme, type Theme } from "./hooks";
import type { EventFocus } from "./types";
import { CommandPalette, useGoSequences, type PaletteAction } from "./components/CommandPalette";
import { InjectDialog } from "./components/InjectDialog";
import { ShortcutsDialog } from "./components/ShortcutsDialog";
import { ToastContainer, copyLink, copyText } from "./components/ui";
import { Agents } from "./views/Agents";
import { Events } from "./views/Events";
import { Graph } from "./views/Graph";
import { Overview } from "./views/Overview";
import { Projects } from "./views/Projects";
import { Proposals } from "./views/Proposals";
import { RunFull } from "./views/RunFull";
import { Runs } from "./views/Runs";
import { Workers } from "./views/Workers";

// Agents rides `g t` ("what is this agent?"): o/e/p/r are taken, and `g a`
// would double-fire the proposals view's `a` (approve) list key — chord
// suffixes must never collide with single-key verbs. Workers keeps its
// natural `g w`: `w` is no view's list verb.
const NAV = [
  { key: "overview", label: "Overview", go: "o" },
  { key: "events", label: "Events", go: "e" },
  { key: "proposals", label: "Proposals", go: "p" },
  { key: "runs", label: "Runs", go: "r" },
  { key: "projects", label: "Projects", go: "f" },
  { key: "agents", label: "Agents", go: "t" },
  { key: "workers", label: "Workers", go: "w" },
  { key: "graph", label: "Graph", go: "g" },
] as const;

// Display-only mirror of the cycle useTheme() implements: both the footer
// control and the ⌘K label promise what one click does, so the promise has to
// name the same order the hook advances in.
const THEME_ORDER: readonly Theme[] = ["dark", "light", "contrast"];

export function App() {
  const [route, navigate] = useHashRoute();
  const view = route[0];
  const [theme, cycleTheme] = useTheme();
  const [injectOpen, setInjectOpen] = useState(false);
  const [injectSeed, setInjectSeed] = useState<Record<string, unknown> | undefined>(undefined);
  const [helpOpen, setHelpOpen] = useState(false);
  const [focusRunState, setFocusRunState] = useState<string | null>(null);
  const [focusExpired, setFocusExpired] = useState(false);
  const [ephemeralEvent, setEphemeralEvent] = useState<EventFocus | null>(null);
  const [filterFocus, setFilterFocus] = useState(false);

  const focusRunId = view === "runs" ? (route[1] ?? null) : null;
  // `#/run/:id` is the full-page run view — a distinct first segment, so
  // crossing from `#/runs/:id` pushes history and Back restores the panel.
  const fullRunId = view === "run" ? (route[1] ?? null) : null;
  const focusProposalId = view === "proposals" ? (route[1] ?? null) : null;
  const focusRepoName = view === "projects" ? (route[1] ?? null) : null;
  const focusAgentRef = view === "agents" ? (route[1] ?? null) : null;
  const focusWorkerId = view === "workers" ? (route[1] ?? null) : null;
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
  const openRunFull = (runId: string) => navigate(hashPath("run", runId));
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
  const jumpToWorker = (id: string) => navigate(hashPath("workers", id));
  const jumpToProject = (name: string) => navigate(hashPath("projects", name));
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
  const busyWorkers = status.data?.workers.busy ?? 0;
  const staleWorkers = status.data?.workers.stale ?? 0;
  // null until the first status lands: reading "no workers" off a pending
  // fetch is the same false alarm as flashing "unreachable" on first load.
  const liveWorkers = status.data?.workers.live ?? null;

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
    const label = nav?.label ?? (view === "run" ? "Run" : "Overview");
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

  const nextTheme = THEME_ORDER[(THEME_ORDER.indexOf(theme) + 1) % THEME_ORDER.length];

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
    { label: `Cycle theme (${THEME_ORDER.join(" → ")})`, run: cycleTheme },
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
            // Workers is the one badge whose meaning can flip: a stale
            // heartbeat is a worker that is gone while claiming to work, so it
            // outranks the busy count. The word carries that — reading the
            // count off the tone alone fails in the contrast theme.
            const badge: { count: number; hue: string; word?: string; title?: string } =
              n.key === "proposals"
                ? { count: openProposals, hue: "var(--accent)" }
                : n.key === "runs"
                  ? { count: activeRuns, hue: "var(--accent)" }
                  : n.key === "events"
                    ? { count: eventAttention, hue: "var(--accent)" }
                    : n.key === "workers"
                      ? staleWorkers > 0
                        ? {
                            count: staleWorkers,
                            hue: "var(--hue-warn)",
                            word: "stale",
                            title: `${staleWorkers} worker${staleWorkers === 1 ? "" : "s"} whose heartbeat has gone stale`,
                          }
                        : {
                            count: busyWorkers,
                            hue: "var(--accent)",
                            title: `${busyWorkers} worker${busyWorkers === 1 ? "" : "s"} busy`,
                          }
                      : { count: 0, hue: "var(--accent)" };
            return (
              <button
                key={n.key}
                type="button"
                aria-current={view === n.key || (n.key === "runs" && view === "run") ? "page" : undefined}
                onClick={() => navigate(n.key)}
                className={`flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left text-[13px] ${
                  view === n.key || (n.key === "runs" && view === "run")
                    ? "bg-(--surface-3) font-medium text-(--text)"
                    : "text-(--text-dim) hover:bg-(--surface-2)"
                }`}
              >
                <span>{n.label}</span>
                {badge.count > 0 && (
                  <span
                    className="rounded px-1.5 text-[11px] tabular-nums"
                    title={badge.title}
                    style={{
                      color: badge.hue,
                      background: `color-mix(in oklch, ${badge.hue} 14%, transparent)`,
                    }}
                  >
                    {badge.count}
                    {badge.word && <span className="ml-1">{badge.word}</span>}
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
              className="size-2 shrink-0 rounded-full"
              style={{ background: connected ? "var(--hue-ok)" : "var(--hue-err)" }}
            />
            {connected ? (
              <span className="text-(--text-dim)">
                connected · <span className="mono">{health.data?.policyVersion}</span>
                {liveWorkers !== null && (
                  <>
                    {" "}
                    {/* One unbreakable token: at this nav width the fragment
                        always wraps, and a bare "1" ending the line above its
                        own "worker" reads as a different number. */}
                    <span
                      className="whitespace-nowrap"
                      style={staleWorkers > 0 ? { color: "var(--hue-warn)" } : undefined}
                      title={
                        staleWorkers > 0
                          ? `${liveWorkers} live · ${staleWorkers} worker${staleWorkers === 1 ? "" : "s"} whose heartbeat has gone stale`
                          : `${liveWorkers} live worker${liveWorkers === 1 ? "" : "s"}`
                      }
                    >
                      ·{" "}
                      {liveWorkers === 0
                        ? "no workers"
                        : `${liveWorkers} worker${liveWorkers === 1 ? "" : "s"}`}
                    </span>
                  </>
                )}
              </span>
            ) : (
              <span style={{ color: "var(--hue-err)" }}>runtime unreachable</span>
            )}
          </div>
          <div className="mt-1.5 text-(--text-faint)">
            <span className="mono">⌘K</span> commands · <span className="mono">g</span>+
            <span className="mono">o/e/p/r/t/w/g</span> · <span className="mono">/</span> filter ·{" "}
            <span className="mono">i</span> inject · <span className="mono">?</span> keys
          </div>
          {/* Named, not just toggled: "contrast" is the accessibility theme, and
              an operator who lands in it by accident needs to read where they
              are before the swatch tells them anything. */}
          <button
            type="button"
            onClick={cycleTheme}
            title={`Theme ${theme} — click for ${nextTheme}`}
            aria-label={`Theme: ${theme}. Switch to ${nextTheme}.`}
            className="mt-2 flex w-full cursor-pointer items-center justify-between gap-2 rounded-md border border-(--border-strong) px-1.5 py-0.5 text-(--text-dim) hover:bg-(--surface-2) hover:text-(--text)"
          >
            <span>Theme</span>
            <span className="text-(--text)">{theme}</span>
          </button>
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
          ) : view === "run" && fullRunId ? (
            <RunFull
              runId={fullRunId}
              connected={connected}
              onBack={() => navigate(hashPath("runs", fullRunId))}
              onJumpAgent={jumpToAgent}
              onJumpEvent={jumpToEvent}
            />
          ) : view === "runs" || view === "run" ? (
            <Runs
              connected={connected}
              focusRunId={focusRunId}
              onSelectRun={(id) => navigate(hashPath("runs", id))}
              onOpenFull={openRunFull}
              focusState={focusRunState}
              onFocusStateConsumed={() => setFocusRunState(null)}
              onJumpAgent={jumpToAgent}
              onJumpEvent={jumpToEvent}
            />
          ) : view === "projects" ? (
            <Projects
              connected={connected}
              focusRepoName={focusRepoName}
              onSelectRepo={(name) => navigate(hashPath("projects", name))}
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
          ) : view === "workers" ? (
            <Workers
              focusWorkerId={focusWorkerId}
              onSelectWorker={(id) => navigate(hashPath("workers", id))}
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
        onJumpWorker={jumpToWorker}
        onJumpProject={jumpToProject}
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
