import { Dialog } from "./ui";

const ROWS: { keys: string; does: string }[] = [
  { keys: "⌘K", does: "command palette" },
  { keys: "g o / e / p / r / t / g", does: "Overview / Events / Proposals / Runs / Agents / Graph" },
  { keys: "i", does: "inject event" },
  { keys: "j k  ↑↓", does: "move list selection" },
  { keys: "Enter / o", does: "open detail" },
  { keys: "Esc", does: "close panel or dialog" },
  { keys: "c", does: "copy selected id" },
  { keys: "a", does: "approve selected proposal" },
  { keys: "x", does: "reject proposal / cancel run" },
  { keys: "q", does: "requeue dead-lettered / human_needed event" },
  { keys: "?", does: "this list" },
];

/** Keyboard cheatsheet (Linear's `?`). Spec §5 is the contract; this is the reminder. */
export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog title="Keyboard" onClose={onClose}>
      <div className="text-[12px] text-(--text-dim)">
        {ROWS.map((r) => (
          <div key={r.keys} className="flex items-baseline justify-between gap-4 border-b border-(--border) py-1.5 last:border-0">
            <span className="mono text-(--text)">{r.keys}</span>
            <span className="text-right text-(--text-faint)">{r.does}</span>
          </div>
        ))}
      </div>
    </Dialog>
  );
}
