// Agents rides `g t` ("what is this agent?"): o/e/p/r are taken, and `g a`
// would double-fire the proposals view's `a` (approve) list key. Artifacts uses
// `g y` (the last sound in "artifact") so it does not compete with list `k`.
// Workers keeps its natural `g w`: `w` is no view's list verb. Inbox takes
// `g n` ("needs you"): `n` is no view's list verb either, and `g i` is the
// In-flight context chord (WM-235). Number keys 1–6 belong to an undecided
// DecisionCard whenever one is on screen (capture-phase window listener, so
// Inbox's 1–4 status tabs never see them); with no open card the tabs keep
// their existing binding. Chains rides `g l` ("chain link"): its natural `c`
// went to Settings (WM-704, config) first (WM-537).
export type NavGroup = "live" | "work" | "machinery" | "system";

export const NAV = [
  // Attention / Live Actions (badge-carrying / immediate triage)
  { key: "overview", label: "Overview", go: "o", group: "live" },
  { key: "inbox", label: "Inbox", go: "n", group: "live" },
  { key: "proposals", label: "Proposals", go: "p", group: "live" },
  { key: "runs", label: "Runs", go: "r", group: "live" },
  { key: "events", label: "Events", go: "e", group: "live" },

  // Work Journey (artifact and execution lifecycle)
  { key: "tickets", label: "Tickets", go: "k", group: "work" },
  { key: "chains", label: "Chains", go: "l", group: "work" },
  { key: "projects", label: "Projects", go: "f", group: "work" },
  { key: "artifacts", label: "Artifacts", go: "y", group: "work" },

  // Machinery & Topology (configuration, workers, cadence, graph)
  { key: "agents", label: "Agents", go: "t", group: "machinery" },
  { key: "workers", label: "Workers", go: "w", group: "machinery" },
  { key: "schedules", label: "Schedules", go: "s", group: "machinery" },
  { key: "graph", label: "Graph", go: "g", group: "machinery" },

  // System
  { key: "settings", label: "Settings", go: "c", group: "system" },
] as const;

export type NavItem = (typeof NAV)[number];
export type NavKey = NavItem["key"];

