import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import { modal, useNow } from "../hooks";

/** One fixed hue map for the closed §8 lifecycle — identical in every view. */
export const STATE_HUES: Record<string, string> = {
  PROPOSED: "var(--hue-idle)",
  APPROVED: "var(--hue-info)",
  QUEUED: "var(--hue-info)",
  LEASED: "var(--hue-warn)",
  RUNNING: "var(--hue-warn)",
  VERIFYING: "var(--hue-verify)",
  COMPLETED: "var(--hue-ok)",
  REFUSED: "var(--hue-warn)",
  FAILED: "var(--hue-err)",
  TIMED_OUT: "var(--hue-err)",
  CANCELLED: "var(--hue-idle)",
};

/** One hue map for the §5 event-inbox statuses — identical in every view. */
export const EVENT_STATUS_HUES: Record<string, string> = {
  admitted: "var(--hue-info)",
  planned: "var(--hue-ok)",
  noop: "var(--hue-idle)",
  human_needed: "var(--hue-warn)",
  dead_lettered: "var(--hue-err)",
};

/** One hue map for decided-proposal statuses — identical in list and panel. */
export const PROPOSAL_STATUS_HUES: Record<string, string> = {
  open: "var(--hue-info)",
  approved: "var(--hue-ok)",
  rejected: "var(--hue-err)",
  superseded: "var(--hue-idle)",
  resolved: "var(--hue-idle)",
};

export const DECISION_HUES: Record<string, string> = {
  run: "var(--hue-info)",
  human_needed: "var(--hue-warn)",
  noop: "var(--hue-idle)",
};

export function copyText(text: string, label: string) {
  navigator.clipboard.writeText(text);
  notify(`Copied ${label}`, "info");
}

/** Shareable hash of the current selection — the payoff of hash-as-source-of-truth. */
export function copyLink() {
  copyText(window.location.href, "link");
}

export function FilterInput({
  value,
  onChange,
  placeholder,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  label: string;
}) {
  return (
    <span className="relative inline-flex w-56 shrink-0">
      <input
        data-view-filter
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          e.preventDefault();
          if (value) onChange("");
          else e.currentTarget.blur();
        }}
        placeholder={placeholder}
        aria-label={label}
        className="w-full rounded-md border border-(--border) bg-(--surface-1) px-2.5 py-1 pr-7 text-[12px] text-(--text) outline-none placeholder:text-(--text-faint) focus:border-(--accent)"
      />
      {!value && (
        <kbd
          aria-hidden
          className="pointer-events-none absolute top-1/2 right-1.5 -translate-y-1/2 rounded border border-(--border) px-1 font-sans text-[10px] text-(--text-faint)"
        >
          /
        </kbd>
      )}
    </span>
  );
}

/** Empty / loading / error row for the dense lists. Never say "none" while pending. */
export function ListEmpty({
  colSpan,
  query,
  filtered,
  noun,
  empty,
  action,
}: {
  colSpan: number;
  query: { isPending: boolean; isError: boolean; data?: unknown };
  filtered?: boolean;
  noun: string;
  empty: string;
  action?: ReactNode;
}) {
  let msg = empty;
  if (query.isPending && !query.data) msg = `Loading ${noun}…`;
  else if (query.isError && !query.data) {
    msg = `Cannot reach the control API — ${noun} will appear when it is up.`;
  } else if (filtered) msg = `No ${noun} match this filter.`;
  return (
    <tr>
      <td colSpan={colSpan} className="px-3 py-8 text-center text-(--text-faint)">
        <div>{msg}</div>
        {action && !query.isPending && !query.isError && !filtered && <div className="mt-3">{action}</div>}
      </td>
    </tr>
  );
}

export function StateBadge({
  state,
  hues = STATE_HUES,
}: {
  state: string;
  hues?: Record<string, string>;
}) {
  const hue = hues[state] ?? "var(--hue-idle)";
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 text-[11px] font-medium"
      style={{ color: hue, background: `color-mix(in oklch, ${hue} 12%, transparent)` }}
    >
      <span className="size-1.5 rounded-full" style={{ background: hue }} />
      {state}
    </span>
  );
}

export function StatTile({
  label,
  value,
  hue,
  onClick,
}: {
  label: string;
  value: ReactNode;
  hue?: string;
  onClick?: () => void;
}) {
  const inner = (
    <>
      <div className="text-[11px] text-(--text-faint)">{label}</div>
      <div className="display text-xl tabular-nums" style={hue ? { color: hue } : undefined}>
        {value}
      </div>
    </>
  );
  const cls = "rounded-md border border-(--border) bg-(--surface-1) px-3 py-2 text-left";
  if (!onClick) return <div className={cls}>{inner}</div>;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`${label}: ${value}`}
      className={`${cls} cursor-pointer hover:bg-(--surface-2)`}
    >
      {inner}
    </button>
  );
}

/** In-table / KV jump that does not select the parent row. */
export function JumpLink({
  children,
  onClick,
  title,
  className,
}: {
  children: ReactNode;
  onClick: () => void;
  title?: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={`mono cursor-pointer text-left hover:text-(--accent) ${className ?? ""}`}
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      {children}
    </button>
  );
}

export function Countdown({ createdAt, ttlSeconds }: { createdAt: string; ttlSeconds: number }) {
  const now = useNow();
  const left = Math.floor((new Date(createdAt).getTime() + ttlSeconds * 1000 - now) / 1000);
  if (left <= 0) return <span style={{ color: "var(--hue-err)" }}>expired</span>;
  const m = Math.floor(left / 60);
  const s = left % 60;
  const low = left < 300;
  return (
    <span className="tabular-nums" style={low ? { color: "var(--hue-warn)" } : undefined}>
      {m}:{String(s).padStart(2, "0")}
    </span>
  );
}

export function ago(iso: string | null | undefined, now: number): string {
  if (!iso) return "-";
  const s = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** Relative time with the absolute ISO on hover — operators check both. */
export function Ago({
  iso,
  now,
  className,
}: {
  iso: string | null | undefined;
  now: number;
  className?: string;
}) {
  if (!iso) return <span className={className}>-</span>;
  return (
    <span className={className} title={iso}>
      {ago(iso, now)}
    </span>
  );
}

export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export interface ToastMessage {
  id: string;
  type: "ok" | "err" | "info";
  message: string;
}

const toastListeners = new Set<(toasts: ToastMessage[]) => void>();
let activeToasts: ToastMessage[] = [];

export function notify(message: string, type: "ok" | "err" | "info" = "ok") {
  const id = Math.random().toString(36).slice(2);
  activeToasts = [...activeToasts, { id, type, message }].slice(-5);
  toastListeners.forEach((l) => l(activeToasts));
  setTimeout(() => dismissToast(id), 3000);
}

function dismissToast(id: string) {
  const next = activeToasts.filter((t) => t.id !== id);
  if (next.length === activeToasts.length) return;
  activeToasts = next;
  toastListeners.forEach((l) => l(activeToasts));
}

export function ToastContainer() {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  useEffect(() => {
    toastListeners.add(setToasts);
    return () => {
      toastListeners.delete(setToasts);
    };
  }, []);

  if (toasts.length === 0) return null;
  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 pointer-events-none">
      {toasts.map((t) => (
        <div
          key={t.id}
          role="status"
          title="Dismiss"
          onClick={() => dismissToast(t.id)}
          className="pointer-events-auto flex cursor-pointer items-center gap-2 rounded-md border bg-(--surface-1) px-3 py-2 text-[12px] shadow-xl transition-all"
          style={{
            borderColor: t.type === "err" ? "var(--hue-err)" : t.type === "ok" ? "var(--hue-ok)" : "var(--accent)",
          }}
        >
          <span
            className="size-2 rounded-full"
            style={{
              background: t.type === "err" ? "var(--hue-err)" : t.type === "ok" ? "var(--hue-ok)" : "var(--accent)",
            }}
          />
          <span className="text-(--text) font-medium">{t.message}</span>
        </div>
      ))}
    </div>
  );
}

export function JsonBlock({ value }: { value: unknown }) {
  const [copied, setCopied] = useState(false);
  const text = useMemo(() => JSON.stringify(value, null, 2), [value]);

  const copy = () => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    notify("Copied JSON to clipboard", "info");
    setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div className="relative group">
      <pre className="mono overflow-auto rounded-md border border-(--border) bg-(--surface-0) p-3 pr-16 leading-relaxed whitespace-pre-wrap">
        {text}
      </pre>
      <button
        type="button"
        onClick={copy}
        className="absolute top-2 right-2 rounded border border-(--border) bg-(--surface-1) px-2 py-0.5 text-[10px] font-medium text-(--text-dim) opacity-0 transition-opacity group-hover:opacity-100 hover:bg-(--surface-2) hover:text-(--text)"
      >
        {copied ? "Copied!" : "Copy"}
      </button>
    </div>
  );
}

/** Collapsible block for secondary payloads (result artifact, evidence). */
export function Disclosure({
  label,
  children,
  defaultOpen,
}: {
  label: string;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  return (
    <details open={defaultOpen} className="mb-1.5">
      <summary className="cursor-pointer text-[11px] text-(--text-faint) select-none hover:text-(--text-dim)">
        {label}
      </summary>
      <div className="mt-1.5">{children}</div>
    </details>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mb-5">
      <div className="mb-1.5 text-[11px] font-medium tracking-wide text-(--text-faint) uppercase">
        {title}
      </div>
      {children}
    </div>
  );
}

export function KV({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="flex justify-between gap-4 border-b border-(--border) py-1 last:border-0">
      <span className="text-(--text-faint)">{k}</span>
      <span className="mono truncate text-(--text-dim)" title={typeof v === "string" ? v : undefined}>
        {v ?? "-"}
      </span>
    </div>
  );
}

export function Button({
  children,
  onClick,
  variant = "default",
  disabled,
  autoFocus,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "default" | "primary" | "danger";
  disabled?: boolean;
  autoFocus?: boolean;
}) {
  const styles = {
    default: "border-(--border-strong) bg-(--surface-2) text-(--text) hover:bg-(--surface-3)",
    primary: "border-transparent bg-(--accent) text-white hover:opacity-90",
    danger:
      "border-(--border-strong) bg-(--surface-2) hover:bg-(--surface-3) text-[color:var(--hue-err)]",
  }[variant];
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      autoFocus={autoFocus}
      className={`rounded-md border px-2.5 py-1 text-[12px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${styles}`}
    >
      {children}
    </button>
  );
}

const FOCUSABLE =
  "a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])";

function tabCycle(root: HTMLElement, e: KeyboardEvent) {
  const nodes = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => el.offsetParent !== null || el === document.activeElement,
  );
  if (nodes.length === 0) {
    e.preventDefault();
    root.focus();
    return;
  }
  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  const active = document.activeElement;
  if (e.shiftKey) {
    if (active === first || !root.contains(active)) {
      e.preventDefault();
      last.focus();
    }
  } else if (active === last || !root.contains(active)) {
    e.preventDefault();
    first.focus();
  }
}

export function Dialog({
  title,
  onClose,
  children,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    modal.depth += 1;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "Tab" && panelRef.current) tabCycle(panelRef.current, e);
    };
    window.addEventListener("keydown", onKey);
    const root = panelRef.current;
    const pref = root?.querySelector<HTMLElement>("[autofocus]");
    (pref ?? root)?.focus();
    return () => {
      modal.depth -= 1;
      window.removeEventListener("keydown", onKey);
      previous?.focus();
    };
  }, [onClose]);
  return (
    <div
      className="fixed inset-0 z-40 flex items-start justify-center bg-black/50 pt-[12vh]"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`${wide ? "w-[720px]" : "w-[480px]"} max-h-[70vh] overflow-auto rounded-lg border border-(--border-strong) bg-(--surface-1) p-4 shadow-2xl outline-none`}
      >
        <div id={titleId} className="display mb-3 text-[15px] font-semibold">
          {title}
        </div>
        {children}
      </div>
    </div>
  );
}

/** Inline verb-failure line: 404/409 are normal raced outcomes (spec §6). */
export function VerbError({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <div
      className="mt-2 rounded-md px-2.5 py-1.5 text-[12px]"
      style={{
        color: "var(--hue-err)",
        background: "color-mix(in oklch, var(--hue-err) 10%, transparent)",
      }}
    >
      {(error as Error).message}
    </div>
  );
}
