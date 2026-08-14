import { useCallback, useSyncExternalStore } from "react";
import type { PaletteAction } from "./components/CommandPalette";

// Views register verbs for the current selection so the ⌘K palette can offer
// them (webui spec §5: "invoke the verbs valid for the current selection").
// A tiny external store keeps selection state where it lives — in the views.

let contextActions: PaletteAction[] = [];
const listeners = new Set<() => void>();

export function setContextActions(actions: PaletteAction[]) {
  contextActions = actions;
  for (const l of listeners) l();
}

export function useContextActions(): PaletteAction[] {
  const subscribe = useCallback((onChange: () => void) => {
    listeners.add(onChange);
    return () => listeners.delete(onChange);
  }, []);
  return useSyncExternalStore(subscribe, () => contextActions);
}
