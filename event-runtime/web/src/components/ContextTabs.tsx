import { useEffect, useMemo, useRef, useState } from "react";
import type { OperatorContext } from "../context";
import { INFLIGHT } from "../context";
import { CONTEXT_TABS_ATTR } from "../hooks";
import type { RepoItem } from "../types";

export function ScopeCaption({
  context,
  surface,
}: {
  context: OperatorContext;
  surface: "fleet" | "registry" | "graph" | "overview";
}) {
  if (context.kind === "all") return null;
  const text =
    context.kind === "inflight"
      ? surface === "overview"
        ? "In flight scopes the Runs list — counts below are factory-wide."
        : "In flight scopes the Runs list — this view is not."
      : surface === "fleet"
        ? `Fleet is not scoped to ${context.name}.`
        : surface === "registry"
          ? `The registry is not scoped to ${context.name}.`
          : surface === "graph"
            ? `The graph is not scoped to ${context.name}.`
            : `Overview counts are factory-wide — they are not scoped to ${context.name}.`;
  return <p className="mb-3 text-[11px] text-(--text-faint)">{text}</p>;
}

/**
 * Linear-style context strip: All (pinned) · open repos · In flight (pinned) · +.
 * A tab is a filter, not a container. Closing a repo tab returns to All.
 */
export function ContextTabs({
  repos,
  reposError,
  openRepos,
  active,
  onSelect,
  onOpen,
  onClose,
}: {
  repos: RepoItem[];
  reposError: boolean;
  openRepos: string[];
  active: OperatorContext;
  onSelect: (ctx: OperatorContext) => void;
  onOpen: (name: string) => void;
  onClose: (name: string) => void;
}) {
  const [picker, setPicker] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const available = useMemo(
    () => repos.filter((r) => !openRepos.includes(r.name)),
    [repos, openRepos],
  );
  const activeId = active.kind === "repo" ? active.name : active.kind;
  const activeTab = () =>
    stripRef.current?.querySelector<HTMLElement>('[aria-pressed="true"]') ?? null;

  const tabIds = useMemo(() => ["all", ...openRepos, INFLIGHT], [openRepos]);
  const [tabStopId, setTabStopId] = useState<string | null>(null);

  const effectiveTabStop = useMemo(() => {
    if (tabStopId && tabIds.includes(tabStopId)) return tabStopId;
    if (tabIds.includes(activeId)) return activeId;
    return "all";
  }, [tabStopId, tabIds, activeId]);

  useEffect(() => {
    setTabStopId(tabIds.includes(activeId) ? activeId : "all");
  }, [activeId, tabIds]);

  // The strip scrolls its own active tab: `[` / `]` scroll-into-view belongs to
  // the view's status tabs, and a repo tab can go active without being clicked
  // (opening a project, the command palette), so it may sit past the overflow.
  useEffect(() => {
    activeTab()?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }, [activeId]);

  // A closed tab takes its × button with it. Chromium focuses the button on
  // click, so unmount drops focus to <body> and the next Tab restarts at the
  // top of the page. Safari/Firefox leave focus where it was (a list row, a
  // filter); only recover when it was actually lost.
  const [closes, setCloses] = useState(0);
  useEffect(() => {
    if (!closes) return;
    const focused = document.activeElement;
    if (focused == null || focused === document.body) activeTab()?.focus();
  }, [closes]);

  useEffect(() => {
    if (!picker) return;
    function onDoc(e: MouseEvent) {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) setPicker(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      setPicker(false);
    }
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [picker]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const target = (e.target as HTMLElement | null)?.closest<HTMLButtonElement>("[data-context-tab]");
    if (!target) return;
    const currentId = target.getAttribute("data-context-tab");
    if (!currentId) return;
    const currentIndex = tabIds.indexOf(currentId);
    if (currentIndex === -1) return;

    if (e.key === "ArrowRight") {
      e.preventDefault();
      const nextIndex = (currentIndex + 1) % tabIds.length;
      const nextId = tabIds[nextIndex];
      setTabStopId(nextId);
      const btn = stripRef.current?.querySelector<HTMLButtonElement>(`[data-context-tab="${nextId}"]`);
      btn?.focus();
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      const nextIndex = (currentIndex - 1 + tabIds.length) % tabIds.length;
      const nextId = tabIds[nextIndex];
      setTabStopId(nextId);
      const btn = stripRef.current?.querySelector<HTMLButtonElement>(`[data-context-tab="${nextId}"]`);
      btn?.focus();
    } else if (e.key === "Home") {
      e.preventDefault();
      const nextId = tabIds[0];
      setTabStopId(nextId);
      const btn = stripRef.current?.querySelector<HTMLButtonElement>(`[data-context-tab="${nextId}"]`);
      btn?.focus();
    } else if (e.key === "End") {
      e.preventDefault();
      const nextId = tabIds[tabIds.length - 1];
      setTabStopId(nextId);
      const btn = stripRef.current?.querySelector<HTMLButtonElement>(`[data-context-tab="${nextId}"]`);
      btn?.focus();
    } else if (e.key === "Delete" || e.key === "Backspace") {
      if (openRepos.includes(currentId)) {
        e.preventDefault();
        e.stopPropagation();
        onClose(currentId);
        setCloses((n) => n + 1);
      }
    }
  };

  const tabClass = (id: string) =>
    `flex shrink-0 items-center gap-1 rounded-md px-2.5 py-1 text-[12px] font-medium ${
      activeId === id ? "bg-(--surface-3) text-(--text)" : "text-(--text-dim) hover:bg-(--surface-2) hover:text-(--text)"
    }`;

  return (
    <div className="flex h-9 shrink-0 items-stretch gap-0.5 border-b border-(--border) bg-(--surface-1) px-2">
      <div
        ref={stripRef}
        className="flex min-w-0 flex-1 items-stretch gap-0.5"
        role="toolbar"
        aria-label="Context"
        onKeyDown={handleKeyDown}
        {...{ [CONTEXT_TABS_ATTR]: "" }}
      >
        <button
          type="button"
          data-context-tab="all"
          tabIndex={effectiveTabStop === "all" ? 0 : -1}
          aria-pressed={active.kind === "all"}
          className={tabClass("all")}
          onClick={() => onSelect({ kind: "all" })}
          onFocus={() => setTabStopId("all")}
        >
          All
        </button>
        <div
          role="presentation"
          className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto"
        >
          {openRepos.map((name) => (
            <div key={name} role="presentation" className="flex shrink-0 items-center">
              <button
                type="button"
                data-context-tab={name}
                tabIndex={effectiveTabStop === name ? 0 : -1}
                aria-pressed={active.kind === "repo" && active.name === name}
                className={tabClass(name)}
                onClick={() => onSelect({ kind: "repo", name })}
                onFocus={() => setTabStopId(name)}
              >
                {name}
              </button>
              <button
                type="button"
                tabIndex={-1}
                aria-label={`Close ${name}`}
                title={`Close ${name}`}
                className="rounded px-1 text-[11px] text-(--text-faint) hover:text-(--text)"
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(name);
                  setCloses((n) => n + 1);
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
        <button
          type="button"
          data-context-tab={INFLIGHT}
          tabIndex={effectiveTabStop === INFLIGHT ? 0 : -1}
          aria-pressed={active.kind === "inflight"}
          className={tabClass(INFLIGHT)}
          onClick={() => onSelect({ kind: "inflight" })}
          onFocus={() => setTabStopId(INFLIGHT)}
        >
          In flight
        </button>
      </div>
      <div className="relative flex shrink-0 items-center" ref={pickerRef}>
        <button
          type="button"
          aria-expanded={picker}
          aria-haspopup="listbox"
          aria-controls="repo-picker-listbox"
          aria-label="Open a repo tab"
          title="Open a repo"
          className="rounded-md px-2 py-1 text-[14px] text-(--text-dim) hover:bg-(--surface-2) hover:text-(--text)"
          onClick={() => setPicker((open) => !open)}
        >
          +
        </button>
        {picker && (
          <div
            id="repo-picker-listbox"
            role="listbox"
            aria-label="Factory repos"
            className="absolute top-full right-0 z-30 mt-1 max-h-72 min-w-48 overflow-auto rounded-md border border-(--border) bg-(--surface-1) py-1 shadow-lg"
          >
            {reposError ? (
              <div className="px-3 py-2 text-[12px] text-(--text-faint)">Cannot reach /repos.</div>
            ) : available.length === 0 ? (
              <div className="px-3 py-2 text-[12px] text-(--text-faint)">
                {repos.length === 0 ? "No repos in the registry." : "All repos are open."}
              </div>
            ) : (
              available.map((r) => (
                <button
                  key={r.name}
                  type="button"
                  role="option"
                  className="block w-full px-3 py-1.5 text-left text-[12px] text-(--text) hover:bg-(--surface-2)"
                  onClick={() => {
                    onOpen(r.name);
                    setPicker(false);
                  }}
                >
                  {r.name}
                  {r.team ? <span className="ml-2 text-(--text-faint)">{r.team}</span> : null}
                </button>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}
