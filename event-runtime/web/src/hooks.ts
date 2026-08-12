import { useCallback, useEffect, useState } from "react";

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
  const parse = () => window.location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  const [route, setRoute] = useState<string[]>(parse);
  useEffect(() => {
    const onChange = () => setRoute(parse());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  const navigate = useCallback((path: string) => {
    window.location.hash = `#/${path}`;
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
