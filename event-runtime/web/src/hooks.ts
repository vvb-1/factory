import { useCallback, useEffect, useState } from "react";
import { parseHash } from "./hash";

/** Open-modal depth: global list-navigation keys stand down while a dialog is up. */
export const modal = { depth: 0 };

/** True when a global shortcut should be ignored (typing, or a modal is open). */
export function keyGuard(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  if (t && t.closest("input, textarea, select, [contenteditable=true]")) return true;
  return modal.depth > 0;
}

/** Hash routing: "#/runs/run_01" → ["runs", "run_01"]. Default view: overview. */
export function useHashRoute(): [string[], (path: string) => void] {
  const read = () => parseHash(window.location.hash);
  const [route, setRoute] = useState<string[]>(read);
  // Query-only hash changes (`#/events?type=`) keep the same path segments;
  // tick so readers of window.location.hash re-render.
  const [, setHash] = useState(window.location.hash);
  useEffect(() => {
    const onChange = () => {
      setRoute(read());
      setHash(window.location.hash);
    };
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  const navigate = useCallback((path: string) => {
    const next = `#/${path}`;
    if (window.location.hash === next) return;
    window.location.hash = next;
  }, []);
  return [route.length ? route : ["overview"], navigate];
}

/**
 * j/k + Enter/Escape list navigation (webui spec §5). `keys` maps extra
 * single keys (e.g. "a" approve) to handlers, active only with a selection.
 */
export function useListKeys(opts: {
  count: number;
  selected: number;
  onSelect: (index: number) => void;
  onOpen?: () => void;
  onClose?: () => void;
  keys?: Record<string, () => void>;
}) {
  const { count, selected, onSelect, onOpen, onClose, keys } = opts;
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (keyGuard(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        if (count) onSelect(Math.min(selected + 1, count - 1));
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        if (count) onSelect(Math.max(selected - 1, 0));
      } else if ((e.key === "Enter" || e.key === "o") && onOpen) {
        e.preventDefault();
        onOpen();
      } else if (e.key === "Escape" && onClose) {
        onClose();
      } else if (keys && keys[e.key] && selected >= 0) {
        e.preventDefault();
        keys[e.key]();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [count, selected, onSelect, onOpen, onClose, keys]);
}

/** `[` / `]` cycle a view's status tabs (Linear's issue-state keys). */
export function useTabKeys<T extends string>(
  tabs: readonly T[],
  current: T,
  onSelect: (tab: T) => void,
) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (keyGuard(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key !== "[" && e.key !== "]") return;
      e.preventDefault();
      const i = tabs.indexOf(current);
      if (i < 0) return;
      const delta = e.key === "]" ? 1 : -1;
      onSelect(tabs[(i + delta + tabs.length) % tabs.length]);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tabs, current, onSelect]);
  useEffect(() => {
    document
      .querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
      ?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }, [current]);
}

const THEMES = ["dark", "light", "contrast"] as const;
export type Theme = (typeof THEMES)[number];

/** Theme state on <html data-theme>; dark is the default (spec §5.1). */
export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(
    () => (localStorage.getItem("evrt-theme") as Theme) || "dark",
  );
  useEffect(() => {
    if (theme === "dark") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    localStorage.setItem("evrt-theme", theme);
  }, [theme]);
  const cycle = useCallback(
    () => setTheme((t) => THEMES[(THEMES.indexOf(t) + 1) % THEMES.length]),
    [],
  );
  return [theme, cycle];
}

/** Ticks every second — drives TTL countdowns and relative timestamps. */
export function useNow(): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}
