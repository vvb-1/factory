import { type ReactNode, useEffect } from "react";
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

export function StateBadge({ state }: { state: string }) {
  const hue = STATE_HUES[state] ?? "var(--hue-idle)";
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

export function StatTile({ label, value, hue }: { label: string; value: ReactNode; hue?: string }) {
  return (
    <div className="rounded-md border border-(--border) bg-(--surface-1) px-3 py-2">
      <div className="text-[11px] text-(--text-faint)">{label}</div>
      <div className="display text-xl tabular-nums" style={hue ? { color: hue } : undefined}>
        {value}
      </div>
    </div>
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

export function JsonBlock({ value }: { value: unknown }) {
  return (
    <pre className="mono overflow-auto rounded-md border border-(--border) bg-(--surface-0) p-3 leading-relaxed whitespace-pre-wrap">
      {JSON.stringify(value, null, 2)}
    </pre>
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
  useEffect(() => {
    modal.depth += 1;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      modal.depth -= 1;
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
  return (
    <div
      className="fixed inset-0 z-40 flex items-start justify-center bg-black/50 pt-[12vh]"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className={`${wide ? "w-[720px]" : "w-[480px]"} max-h-[70vh] overflow-auto rounded-lg border border-(--border-strong) bg-(--surface-1) p-4 shadow-2xl`}
      >
        <div className="display mb-3 text-[15px] font-semibold">{title}</div>
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
