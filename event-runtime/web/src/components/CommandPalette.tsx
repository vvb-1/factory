import { useQuery } from "@tanstack/react-query";
import { Command } from "cmdk";
import { useEffect, useState } from "react";
import { api } from "../api";
import { keyGuard, modal } from "../hooks";
import { useContextActions } from "../palette";

export interface PaletteAction {
  label: string;
  hint?: string;
  run: () => void;
}

/** ⌘K palette (webui spec §5): navigation, selection verbs, jump-to-ID. */
export function CommandPalette({
  actions,
  onJumpRun,
  onJumpProposal,
  onJumpEvent,
  onJumpAgent,
}: {
  actions: PaletteAction[];
  onJumpRun: (runId: string) => void;
  onJumpProposal: (id: string) => void;
  onJumpEvent: (source: string, eventId: string) => void;
  onJumpAgent: (ref: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const contextActions = useContextActions();

  // Jump targets load only while the palette is open; cache keys shared with
  // the views, so this is usually a cache hit, not a request.
  const runs = useQuery({ queryKey: ["runs", "ALL"], queryFn: () => api.runs(), enabled: open });
  const proposals = useQuery({ queryKey: ["proposals"], queryFn: api.proposals, enabled: open });
  const events = useQuery({ queryKey: ["events", "all"], queryFn: () => api.events(), enabled: open });
  const agents = useQuery({ queryKey: ["agents"], queryFn: api.agents, enabled: open });

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!open) return;
    modal.depth += 1;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      modal.depth -= 1;
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[16vh]"
      onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}
    >
      <Command
        className="w-[560px] overflow-hidden rounded-lg border border-(--border-strong) bg-(--surface-1) shadow-2xl"
        loop
      >
        <Command.Input
          autoFocus
          placeholder="Type a command…"
          className="w-full border-b border-(--border) bg-transparent px-4 py-3 text-[14px] text-(--text) outline-none placeholder:text-(--text-faint)"
        />
        <Command.List className="max-h-72 overflow-auto p-1.5">
          <Command.Empty className="px-3 py-6 text-center text-(--text-faint)">
            No matching command
          </Command.Empty>
          {[...contextActions, ...actions].map((a) => (
            <Command.Item
              key={a.label}
              onSelect={() => {
                setOpen(false);
                a.run();
              }}
              className="flex cursor-pointer items-center justify-between rounded-md px-3 py-2 text-[13px] data-[selected=true]:bg-(--surface-3)"
            >
              <span>{a.label}</span>
              {a.hint && <span className="mono text-[11px] text-(--text-faint)">{a.hint}</span>}
            </Command.Item>
          ))}
          {(proposals.data?.proposals ?? []).map((p) => (
            <Command.Item
              key={p.id}
              value={`proposal ${p.id} ${p.agent ?? ""}`}
              onSelect={() => {
                setOpen(false);
                onJumpProposal(p.id);
              }}
              className="flex cursor-pointer items-center justify-between rounded-md px-3 py-2 text-[13px] data-[selected=true]:bg-(--surface-3)"
            >
              <span className="mono truncate">{p.id}</span>
              <span className="ml-3 shrink-0 text-[11px] text-(--text-faint)">
                proposal · {p.agent ?? p.decision}
              </span>
            </Command.Item>
          ))}
          {(events.data?.events ?? []).map((e) => (
            <Command.Item
              key={`${e.source}:${e.eventId}`}
              value={`event ${e.source} ${e.eventId} ${e.type} ${e.status}`}
              onSelect={() => {
                setOpen(false);
                onJumpEvent(e.source, e.eventId);
              }}
              className="flex cursor-pointer items-center justify-between rounded-md px-3 py-2 text-[13px] data-[selected=true]:bg-(--surface-3)"
            >
              <span className="mono truncate">{e.eventId}</span>
              <span className="ml-3 shrink-0 text-[11px] text-(--text-faint)">
                event · {e.source} · {e.status}
              </span>
            </Command.Item>
          ))}
          {(runs.data?.runs ?? []).map((r) => (
            <Command.Item
              key={r.runId}
              value={`run ${r.runId} ${r.state} ${r.agent}`}
              onSelect={() => {
                setOpen(false);
                onJumpRun(r.runId);
              }}
              className="flex cursor-pointer items-center justify-between rounded-md px-3 py-2 text-[13px] data-[selected=true]:bg-(--surface-3)"
            >
              <span className="mono truncate">{r.runId}</span>
              <span className="ml-3 shrink-0 text-[11px] text-(--text-faint)">run · {r.state}</span>
            </Command.Item>
          ))}
          {(agents.data?.agents ?? []).map((a) => (
            <Command.Item
              key={a.ref}
              value={`agent ${a.ref} ${a.id} ${a.outputContract}`}
              onSelect={() => {
                setOpen(false);
                onJumpAgent(a.ref);
              }}
              className="flex cursor-pointer items-center justify-between rounded-md px-3 py-2 text-[13px] data-[selected=true]:bg-(--surface-3)"
            >
              <span className="mono truncate">{a.ref}</span>
              <span className="ml-3 shrink-0 text-[11px] text-(--text-faint)">agent · {a.outputContract}</span>
            </Command.Item>
          ))}
        </Command.List>
        <div className="flex items-center justify-between border-t border-(--border) px-4 py-2 text-[11px] text-(--text-faint)">
          <span><span className="mono font-medium">↑↓</span> Navigate</span>
          <span><span className="mono font-medium">↵</span> Select</span>
          <span><span className="mono font-medium">ESC</span> Close</span>
        </div>
      </Command>
    </div>
  );
}

/** g-then-letter navigation sequences (spec §5): g o, g p, g r, g e. */
export function useGoSequences(map: Record<string, () => void>) {
  useEffect(() => {
    let pendingG = 0;
    function onKey(e: KeyboardEvent) {
      if (keyGuard(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "g") {
        pendingG = Date.now();
        return;
      }
      if (pendingG && Date.now() - pendingG < 800 && map[e.key]) {
        e.preventDefault();
        map[e.key]();
      }
      pendingG = 0;
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [map]);
}
