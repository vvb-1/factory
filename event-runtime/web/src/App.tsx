import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { api } from "./api";
import { useHashRoute, useTheme } from "./hooks";
import { CommandPalette, useGoSequences, type PaletteAction } from "./components/CommandPalette";
import { InjectDialog } from "./components/InjectDialog";
import { Overview } from "./views/Overview";
import { Proposals } from "./views/Proposals";
import { Runs } from "./views/Runs";

const NAV = [
  { key: "overview", label: "Overview", go: "o" },
  { key: "proposals", label: "Proposals", go: "p" },
  { key: "runs", label: "Runs", go: "r" },
] as const;

export function App() {
  const [route, navigate] = useHashRoute();
  const view = route[0];
  const [, cycleTheme] = useTheme();
  const [injectOpen, setInjectOpen] = useState(false);
  const [focusRunId, setFocusRunId] = useState<string | null>(null);
  const [focusProposalId, setFocusProposalId] = useState<string | null>(null);

  const jumpToRun = (runId: string) => {
    setFocusRunId(runId);
    navigate("runs");
  };
  const jumpToProposal = (id: string) => {
    setFocusProposalId(id);
    navigate("proposals");
  };

  // Connection indicator (spec §4.1): reads keep rendering from cache when
  // the runtime is down; verbs disable.
  const health = useQuery({
    queryKey: ["health"],
    queryFn: api.health,
    refetchInterval: 2000,
    retry: false,
  });
  const connected = health.isSuccess;

  const status = useQuery({ queryKey: ["status"], queryFn: api.status, refetchInterval: 2000 });
  const openProposals = status.data?.proposals.open ?? 0;
  const activeRuns = Object.entries(status.data?.runs.byState ?? {})
    .filter(([s]) => ["QUEUED", "LEASED", "RUNNING", "VERIFYING"].includes(s))
    .reduce((sum, [, n]) => sum + (n ?? 0), 0);

  useGoSequences(
    useMemo(
      () => Object.fromEntries(NAV.map((n) => [n.go, () => navigate(n.key)])),
      [navigate],
    ),
  );

  const paletteActions: PaletteAction[] = [
    ...NAV.map((n) => ({ label: `Go to ${n.label}`, hint: `g ${n.go}`, run: () => navigate(n.key) })),
    { label: "Inject event…", run: () => setInjectOpen(true) },
    { label: "Cycle theme (dark → light → contrast)", run: cycleTheme },
  ];

  return (
    <div className="flex h-screen">
      <nav className="flex w-52 shrink-0 flex-col border-r border-(--border) bg-(--surface-1)">
        <div className="display px-4 pt-4 pb-3 text-[14px] font-semibold">event runtime</div>
        <div className="flex-1 px-2">
          {NAV.map((n) => {
            const count = n.key === "proposals" ? openProposals : n.key === "runs" ? activeRuns : 0;
            return (
              <button
                key={n.key}
                type="button"
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
            Inject event…
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
            <span className="mono">o/p/r</span> navigate
          </div>
        </div>
      </nav>

      <main className="min-w-0 flex-1">
        {view === "proposals" ? (
          <Proposals
            connected={connected}
            onRunQueued={jumpToRun}
            focusProposalId={focusProposalId}
            onFocusConsumed={() => setFocusProposalId(null)}
          />
        ) : view === "runs" ? (
          <Runs connected={connected} focusRunId={focusRunId} onFocusConsumed={() => setFocusRunId(null)} />
        ) : (
          <Overview connected={connected} />
        )}
      </main>

      <CommandPalette actions={paletteActions} onJumpRun={jumpToRun} onJumpProposal={jumpToProposal} />
      {injectOpen && <InjectDialog onClose={() => setInjectOpen(false)} />}
    </div>
  );
}
