import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../api";
import { useListKeys } from "../hooks";
import { setContextActions } from "../palette";
import type { JanitorResult } from "../types";
import {
  Button,
  DetailPane,
  Dialog,
  FilterInput,
  KV,
  ListEmpty,
  ListPane,
  Section,
  copyLink,
  copyText,
  notify,
} from "../components/ui";

const TEAM_HUES: Record<string, string> = {
  CLNT: "var(--hue-ok)",
  WM: "var(--accent)",
  CW: "var(--hue-info)",
  LAB: "var(--hue-warn)",
  OPS: "var(--text-dim)",
};

/** Projects view (OPS-300 + OPS-362): configured factory repositories and janitor maintenance. */
export function Projects({
  connected,
  focusRepoName,
  onSelectRepo,
}: {
  connected: boolean;
  focusRepoName: string | null;
  onSelectRepo: (name: string | null) => void;
}) {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState("");
  const [filterMode, setFilterMode] = useState<"ALL" | "DISPATCHABLE" | "REPORT_ONLY">("ALL");

  // Janitor state per selected repo
  const [dryResult, setDryResult] = useState<JanitorResult | null>(null);
  const [applyResult, setApplyResult] = useState<JanitorResult | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmInput, setConfirmInput] = useState("");

  const query = useQuery({
    queryKey: ["repos"],
    queryFn: api.repos,
    refetchInterval: 5000,
  });

  const repos = query.data?.repos ?? [];

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return repos.filter((r) => {
      if (filterMode === "DISPATCHABLE" && r.reportOnly) return false;
      if (filterMode === "REPORT_ONLY" && !r.reportOnly) return false;
      if (!q) return true;
      return (
        r.name.toLowerCase().includes(q) ||
        (r.project && r.project.toLowerCase().includes(q)) ||
        (r.team && r.team.toLowerCase().includes(q)) ||
        (r.github && r.github.toLowerCase().includes(q))
      );
    });
  }, [repos, filter, filterMode]);

  const selectedName = focusRepoName;
  const selectedIndex = useMemo(() => visible.findIndex((r) => r.name === selectedName), [visible, selectedName]);
  const sel = selectedIndex >= 0 ? visible[selectedIndex] : null;

  // Reset janitor results when selected repo changes
  useEffect(() => {
    setDryResult(null);
    setApplyResult(null);
    setConfirmOpen(false);
    setConfirmInput("");
  }, [selectedName]);

  useEffect(() => {
    document.querySelector("tr.row-selected")?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  useEffect(() => {
    if (focusRepoName) setFilter("");
  }, [focusRepoName]);

  useListKeys({
    count: visible.length,
    selected: selectedIndex,
    onSelect: (i) => onSelectRepo(visible[i]?.name ?? null),
    onClose: () => {
      if (selectedName) onSelectRepo(null);
      else if (filter) setFilter("");
    },
    keys: {
      c: () => sel && copyText(sel.name, "repo name"),
    },
  });

  // Janitor dry run mutation
  const dryMutation = useMutation({
    mutationFn: (name: string) => api.janitor(name, false),
    onSuccess: (res) => {
      setDryResult(res);
      setApplyResult(null);
      notify(`Dry run complete: ${res.reclaimable.length} reclaimable worktrees found`);
    },
    onError: (err: ApiError) => {
      notify(`Dry run failed: ${err.message}`);
    },
  });

  // Janitor apply mutation
  const applyMutation = useMutation({
    mutationFn: (name: string) => api.janitor(name, true),
    onSuccess: (res) => {
      setApplyResult(res);
      setConfirmOpen(false);
      setConfirmInput("");
      queryClient.invalidateQueries({ queryKey: ["repos"] });
      notify(`Cleaned ${res.removed.length} worktrees for ${res.repo}`);
    },
    onError: (err: ApiError) => {
      notify(`Janitor apply failed: ${err.message}`);
    },
  });

  // Quick Dispatch mutation for factory agent events
  const quickDispatchMutation = useMutation({
    mutationFn: async ({ type, payload, label }: { type: string; payload: Record<string, unknown>; label: string }) => {
      return { label, res: await api.injectEvent(type, payload) };
    },
    onSuccess: (data) => {
      notify(`Dispatched ${data.label}`);
      queryClient.invalidateQueries({ queryKey: ["events"] });
      queryClient.invalidateQueries({ queryKey: ["proposals"] });
      queryClient.invalidateQueries({ queryKey: ["runs"] });
    },
    onError: (err: ApiError) => {
      notify(`Dispatch failed: ${err.message}`);
    },
  });

  // Context actions for ⌘K palette
  useEffect(() => {
    if (!sel) {
      setContextActions([]);
      return;
    }
    const r = sel;
    setContextActions([
      {
        label: `⚡ Dispatch Triage Scan on ${r.name}`,
        hint: "triage",
        run: () =>
          quickDispatchMutation.mutate({
            type: "factory.triage.requested",
            payload: { repo: r.name },
            label: `Triage Scan on ${r.name}`,
          }),
      },
      {
        label: `⚡ Dispatch Status Report for ${r.name}`,
        hint: "status",
        run: () =>
          quickDispatchMutation.mutate({
            type: "factory.status-report.requested",
            payload: { repos: [r.name] },
            label: `Status Report for ${r.name}`,
          }),
      },
      {
        label: `⚡ Dispatch Janitor Scan on ${r.name}`,
        hint: "janitor",
        run: () =>
          quickDispatchMutation.mutate({
            type: "factory.janitor-scan.requested",
            payload: { repo: r.name },
            label: `Janitor Scan on ${r.name}`,
          }),
      },
      {
        label: `Copy path for ${r.name}`,
        run: () => copyText(r.path, "repo path"),
      },
      {
        label: `Copy link to ${r.name}`,
        run: copyLink,
      },
      {
        label: `Run Janitor dry-run on ${r.name}`,
        hint: "dry",
        run: () => dryMutation.mutate(r.name),
      },
      ...(r.github
        ? [
            {
              label: `Open ${r.name} on GitHub`,
              run: () => window.open(`https://github.com/${r.github}`, "_blank"),
            },
          ]
        : []),
    ]);
    return () => setContextActions([]);
  }, [sel, dryMutation, quickDispatchMutation]);

  return (
    <div className="flex h-full min-w-0">
      <ListPane
        chrome={
          <>
            <h1 className="display mb-4 text-lg font-semibold">Projects</h1>
            <div className="mb-3">
              <FilterInput
                value={filter}
                onChange={setFilter}
                placeholder="Filter repo, project, team, github… (/)"
                label="Filter repositories"
              />
            </div>
            <div className="mb-3 flex gap-1 text-[12px]">
              {(["ALL", "DISPATCHABLE", "REPORT_ONLY"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setFilterMode(mode)}
                  className={`rounded px-2 py-0.5 font-medium transition-colors ${
                    filterMode === mode
                      ? "bg-(--surface-3) text-(--text)"
                      : "text-(--text-dim) hover:bg-(--surface-2) hover:text-(--text)"
                  }`}
                >
                  {mode === "ALL" ? "All" : mode === "DISPATCHABLE" ? "Dispatchable" : "Report-Only"}
                </button>
              ))}
            </div>
          </>
        }
      >
        <table className="w-full border-separate border-spacing-0">
          <thead>
            <tr className="text-left text-[11px] text-(--text-faint)">
              <th className="sticky top-0 z-10 border-b border-(--border) bg-(--surface-0) px-3 py-1.5 font-medium">Name</th>
              <th className="sticky top-0 z-10 border-b border-(--border) bg-(--surface-0) px-3 py-1.5 font-medium">Team</th>
              <th className="sticky top-0 z-10 border-b border-(--border) bg-(--surface-0) px-3 py-1.5 font-medium">Project / GitHub</th>
              <th className="sticky top-0 z-10 border-b border-(--border) bg-(--surface-0) px-3 py-1.5 font-medium">Mode</th>
              <th className="sticky top-0 z-10 border-b border-(--border) bg-(--surface-0) px-3 py-1.5 font-medium">Base</th>
              <th className="sticky top-0 z-10 border-b border-(--border) bg-(--surface-0) px-3 py-1.5 font-medium">Worktree Scripts</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((r, i) => {
              const teamHue = r.team ? TEAM_HUES[r.team] ?? "var(--text-dim)" : "var(--text-dim)";
              return (
                <tr
                  key={r.name}
                  onClick={() => onSelectRepo(r.name)}
                  aria-selected={i === selectedIndex}
                  className={`cursor-pointer hover:bg-(--surface-1) ${i === selectedIndex ? "row-selected" : ""}`}
                >
                  <td className="mono border-b border-(--border) px-3 py-1.5 font-semibold text-(--text)">{r.name}</td>
                  <td className="border-b border-(--border) px-3 py-1.5">
                    {r.team ? (
                      <span
                        className="rounded px-1.5 py-0.2 text-[10px] font-semibold tracking-wide"
                        style={{
                          color: teamHue,
                          background: `color-mix(in oklch, ${teamHue} 15%, transparent)`,
                        }}
                      >
                        {r.team}
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="max-w-64 truncate border-b border-(--border) px-3 py-1.5 text-(--text-dim)">
                    {r.project || r.github || r.path}
                  </td>
                  <td className="border-b border-(--border) px-3 py-1.5">
                    <span
                      className="rounded px-1.5 py-0.2 text-[10px] font-semibold uppercase tracking-wide"
                      style={
                        r.reportOnly
                          ? {
                              color: "var(--text-faint)",
                              background: "color-mix(in oklch, var(--text-faint) 12%, transparent)",
                            }
                          : {
                              color: "var(--hue-ok)",
                              background: "color-mix(in oklch, var(--hue-ok) 14%, transparent)",
                            }
                      }
                    >
                      {r.reportOnly ? "Report Only" : "Dispatchable"}
                    </span>
                  </td>
                  <td className="mono border-b border-(--border) px-3 py-1.5 text-[11px] text-(--text-dim)">
                    {r.base}
                    {r.deployBranch ? ` → ${r.deployBranch}` : ""}
                  </td>
                  <td className="border-b border-(--border) px-3 py-1.5 text-[11px] text-(--text-faint)">
                    {[
                      r.hasWorktreeUp && "up",
                      r.hasWorktreeDown && "down",
                      r.hasWorktreeWarm && "warm",
                    ]
                      .filter(Boolean)
                      .join(" · ") || "—"}
                  </td>
                </tr>
              );
            })}
            {visible.length === 0 && (
              <ListEmpty
                colSpan={6}
                query={query}
                filtered={repos.length > 0}
                noun="repositories"
                empty="No configured repositories in config/repos.yaml."
              />
            )}
          </tbody>
        </table>
      </ListPane>

      {sel && (
        <DetailPane
          widthClass="w-[540px]"
          title={
            <div className="flex items-center gap-2">
              <span className="mono font-bold" title={sel.name}>
                {sel.name}
              </span>
              {sel.team && (
                <span
                  className="rounded px-1.5 py-0.2 text-[10px] font-semibold"
                  style={{
                    color: TEAM_HUES[sel.team] ?? "var(--text-dim)",
                    background: `color-mix(in oklch, ${TEAM_HUES[sel.team] ?? "var(--text-dim)"} 15%, transparent)`,
                  }}
                >
                  {sel.team}
                </span>
              )}
            </div>
          }
          actions={
            <>
              <Button onClick={() => copyText(sel.path, "repo path")}>Copy path</Button>
              <Button onClick={copyLink}>Copy link</Button>
              {sel.github && (
                <a
                  href={`https://github.com/${sel.github}`}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded border border-(--border) px-2 py-1 text-[12px] font-medium text-(--text-dim) hover:bg-(--surface-2) hover:text-(--text)"
                >
                  GitHub ↗
                </a>
              )}
              <Button onClick={() => onSelectRepo(null)}>Close</Button>
            </>
          }
        >
          <div className="space-y-4">
            <Section title="⚡ Quick Dispatch (Agent Tasks)">
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={!connected || quickDispatchMutation.isPending}
                  onClick={() =>
                    quickDispatchMutation.mutate({
                      type: "factory.triage.requested",
                      payload: { repo: sel.name },
                      label: `Triage Scan on ${sel.name}`,
                    })
                  }
                >
                  ⚡ Triage Scan
                </Button>
                <Button
                  disabled={!connected || quickDispatchMutation.isPending}
                  onClick={() =>
                    quickDispatchMutation.mutate({
                      type: "factory.status-report.requested",
                      payload: { repos: [sel.name] },
                      label: `Status Report for ${sel.name}`,
                    })
                  }
                >
                  ⚡ Status Report
                </Button>
                <Button
                  disabled={!connected || quickDispatchMutation.isPending}
                  onClick={() =>
                    quickDispatchMutation.mutate({
                      type: "factory.janitor-scan.requested",
                      payload: { repo: sel.name },
                      label: `Janitor Scan on ${sel.name}`,
                    })
                  }
                >
                  ⚡ Janitor Scan
                </Button>
              </div>
              <div className="mt-1.5 text-[11px] text-(--text-faint)">
                Injects an event into the queue for worker lease with live trace streaming.
              </div>
            </Section>

            <Section title="Configuration">
              <KV k="Name" v={sel.name} />
              {sel.project && <KV k="Project" v={sel.project} />}
              {sel.team && <KV k="Team" v={sel.team} />}
              <KV
                k="Path"
                v={
                  <span
                    onClick={() => copyText(sel.path, "path")}
                    className="cursor-pointer hover:underline"
                    title="Click to copy path"
                  >
                    {sel.path}
                  </span>
                }
              />
              {sel.github && (
                <KV
                  k="GitHub"
                  v={
                    <a
                      href={`https://github.com/${sel.github}`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-(--accent) hover:underline"
                    >
                      {sel.github} ↗
                    </a>
                  }
                />
              )}
              <KV k="Base branch" v={sel.base} />
              {sel.deployBranch && <KV k="Deploy branch" v={sel.deployBranch} />}
              <KV
                k="Execution mode"
                v={
                  <span
                    className="font-medium"
                    style={{ color: sel.reportOnly ? "var(--text-faint)" : "var(--hue-ok)" }}
                  >
                    {sel.reportOnly ? "Report Only (Watched)" : "Autonomous Dispatchable"}
                  </span>
                }
              />
              {sel.maxInFlight !== null && <KV k="Max in flight" v={sel.maxInFlight} />}
              {sel.worktreeRoot && <KV k="Worktrees root" v={sel.worktreeRoot} />}
              {sel.verify && (
                <div className="mt-2">
                  <div className="text-[11px] text-(--text-faint)">Verification Command</div>
                  <pre className="mono mt-1 overflow-auto rounded bg-(--surface-0) p-2 text-[11px] text-(--text-dim)">
                    {sel.verify}
                  </pre>
                </div>
              )}
            </Section>

            <Section title="Worktree Automation Scripts">
              <div className="grid grid-cols-3 gap-2 text-center text-[12px]">
                <div
                  className="rounded border border-(--border) p-2"
                  style={{ opacity: sel.hasWorktreeUp ? 1 : 0.4 }}
                >
                  <div className="text-[10px] text-(--text-faint) uppercase">Up Script</div>
                  <div className="font-semibold">{sel.hasWorktreeUp ? "✓ Present" : "None"}</div>
                </div>
                <div
                  className="rounded border border-(--border) p-2"
                  style={{ opacity: sel.hasWorktreeDown ? 1 : 0.4 }}
                >
                  <div className="text-[10px] text-(--text-faint) uppercase">Down Script</div>
                  <div className="font-semibold">{sel.hasWorktreeDown ? "✓ Present" : "None"}</div>
                </div>
                <div
                  className="rounded border border-(--border) p-2"
                  style={{ opacity: sel.hasWorktreeWarm ? 1 : 0.4 }}
                >
                  <div className="text-[10px] text-(--text-faint) uppercase">Warm Script</div>
                  <div className="font-semibold">{sel.hasWorktreeWarm ? "✓ Present" : "None"}</div>
                </div>
              </div>
            </Section>

            <Section title="Worktree Janitor & Maintenance (OPS-362)">
              <div className="rounded-md border border-(--border) bg-(--surface-0) p-3">
                <div className="text-[12px] text-(--text-dim)">
                  Janitor inspects worktrees in <code className="mono">{sel.worktreeRoot ?? "repo worktrees"}</code>,
                  checks their Linear ticket states, and reclaims finished ticket checkouts.
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Button
                    disabled={!connected || dryMutation.isPending || applyMutation.isPending}
                    onClick={() => dryMutation.mutate(sel.name)}
                  >
                    {dryMutation.isPending ? "Scanning…" : "Run Dry Janitor"}
                  </Button>

                  <Button
                    variant="danger"
                    disabled={
                      !connected ||
                      dryMutation.isPending ||
                      applyMutation.isPending ||
                      !dryResult ||
                      (sel.reportOnly && !sel.hasWorktreeDown)
                    }
                    onClick={() => {
                      setConfirmInput("");
                      setConfirmOpen(true);
                    }}
                  >
                    Clean Reclaimable Worktrees…
                  </Button>

                  <Button
                    disabled={!connected || quickDispatchMutation.isPending}
                    onClick={() =>
                      quickDispatchMutation.mutate({
                        type: "factory.janitor-scan.requested",
                        payload: { repo: sel.name },
                        label: `Janitor Scan on ${sel.name}`,
                      })
                    }
                  >
                    {quickDispatchMutation.isPending ? "Dispatching…" : "Dispatch Scan Event"}
                  </Button>
                </div>

                <div className="mt-2 text-[11px] text-(--text-faint)">
                  Supports direct execution or asynchronous placement dispatch via <code>janitor-scan@1</code> & <code>janitor-apply@1</code> events.
                </div>

                {sel.reportOnly && !sel.hasWorktreeDown && (
                  <div className="mt-2 text-[11px]" style={{ color: "var(--hue-warn)" }}>
                    Apply is disabled: report-only repo "{sel.name}" has no worktree_down script.
                  </div>
                )}

                {dryResult && (
                  <div className="mt-3 space-y-2 border-t border-(--border) pt-3 text-[12px]">
                    <div className="flex items-center justify-between font-medium">
                      <span>Dry Scan Results</span>
                      <span
                        className="rounded px-1.5 py-0.2 text-[11px]"
                        style={{
                          color: dryResult.reclaimable.length > 0 ? "var(--hue-ok)" : "var(--text-faint)",
                          background: `color-mix(in oklch, ${
                            dryResult.reclaimable.length > 0 ? "var(--hue-ok)" : "var(--text-faint)"
                          } 14%, transparent)`,
                        }}
                      >
                        {dryResult.reclaimable.length} reclaimable
                      </span>
                    </div>

                    {dryResult.reclaimable.length > 0 ? (
                      <div>
                        <div className="text-[11px] text-(--text-faint)">Reclaimable (Completed/Canceled):</div>
                        <div className="mono mt-1 flex flex-wrap gap-1.5">
                          {dryResult.reclaimable.map((t) => (
                            <span
                              key={t.id}
                              className="rounded border border-(--border) bg-(--surface-1) px-1.5 py-0.5 text-[11px]"
                            >
                              {t.id} <span className="opacity-60">({t.state})</span>
                            </span>
                          ))}
                        </div>
                      </div>
                    ) : (
                      <div className="text-[11px] text-(--text-faint)">No finished worktrees to reclaim.</div>
                    )}

                    {dryResult.kept.length > 0 && (
                      <div>
                        <div className="text-[11px] text-(--text-faint)">Kept (In Progress/Active):</div>
                        <div className="mono mt-1 flex flex-wrap gap-1.5">
                          {dryResult.kept.map((t) => (
                            <span
                              key={t.id}
                              className="rounded border border-(--border) bg-(--surface-1) px-1.5 py-0.5 text-[11px] text-(--text-dim)"
                            >
                              {t.id} <span className="opacity-60">({t.state})</span>
                            </span>
                          ))}
                        </div>
                      </div>
                    )}

                    {dryResult.named.length > 0 && (
                      <div className="text-[11px] text-(--text-faint)">
                        Named/custom worktrees (kept safe): {dryResult.named.join(", ")}
                      </div>
                    )}

                    {dryResult.unknown.length > 0 && (
                      <div className="text-[11px] text-(--text-faint)">
                        Unknown tickets (kept safe): {dryResult.unknown.join(", ")}
                      </div>
                    )}
                  </div>
                )}

                {applyResult && (
                  <div className="mt-3 space-y-2 border-t border-(--border) pt-3 text-[12px]">
                    <div className="font-semibold text-(--hue-ok)">Janitor Apply Execution Finished</div>
                    {applyResult.removed.length > 0 && (
                      <div>
                        <div className="text-[11px] text-(--text-faint)">Removed Worktrees:</div>
                        <div className="mono mt-1 flex flex-wrap gap-1.5">
                          {applyResult.removed.map((id) => (
                            <span
                              key={id}
                              className="rounded border border-(--border) bg-(--surface-1) px-1.5 py-0.5 text-[11px] text-(--hue-ok)"
                            >
                              ✓ {id}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}

                    {applyResult.refused.length > 0 && (
                      <div>
                        <div className="text-[11px]" style={{ color: "var(--hue-err)" }}>
                          Refused (Uncommitted or Unpushed Work):
                        </div>
                        <div className="mono mt-1 space-y-1">
                          {applyResult.refused.map((r) => (
                            <div
                              key={r.id}
                              className="rounded border border-(--border) bg-(--surface-1) p-1.5 text-[11px]"
                            >
                              <span className="font-bold">{r.id}:</span> {r.reason}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {applyResult.skippedApplyReason && (
                      <div className="text-[11px]" style={{ color: "var(--hue-warn)" }}>
                        {applyResult.skippedApplyReason}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </Section>
          </div>
        </DetailPane>
      )}

      {confirmOpen && sel && (
        <Dialog
          title={`Clean Worktrees for ${sel.name}`}
          onClose={() => setConfirmOpen(false)}
        >
          <div className="space-y-3">
            <div className="text-[13px] text-(--text-dim)">
              This will run <code className="mono">{sel.hasWorktreeDown ? "worktree_down" : "janitor"}</code> on{" "}
              <strong>{dryResult?.reclaimable.length ?? 0} reclaimable worktrees</strong>. Worktrees with uncommitted
              changes will be safely refused.
            </div>

            <div>
              <label className="text-[11px] font-medium text-(--text-faint)">
                Type <span className="mono font-bold text-(--text)">{sel.name}</span> to confirm:
              </label>
              <input
                type="text"
                autoFocus
                value={confirmInput}
                onChange={(e) => setConfirmInput(e.target.value)}
                placeholder={sel.name}
                className="mono mt-1 w-full rounded border border-(--border) bg-(--surface-0) px-3 py-1.5 text-[13px] text-(--text) outline-none focus:border-(--accent)"
              />
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <Button onClick={() => setConfirmOpen(false)}>Cancel</Button>
              <Button
                variant="danger"
                disabled={confirmInput.trim() !== sel.name || applyMutation.isPending}
                onClick={() => applyMutation.mutate(sel.name)}
              >
                {applyMutation.isPending ? "Tearing down…" : "Confirm & Clean"}
              </Button>
            </div>
          </div>
        </Dialog>
      )}
    </div>
  );
}
