// Agents rides `g t` ("what is this agent?"): o/e/p/r are taken, and `g a`
// would double-fire the proposals view's `a` (approve) list key — chord
// suffixes must never collide with single-key verbs. Workers keeps its
// natural `g w`: `w` is no view's list verb.
export const NAV = [
  { key: "overview", label: "Overview", go: "o" },
  { key: "events", label: "Events", go: "e" },
  { key: "proposals", label: "Proposals", go: "p" },
  { key: "runs", label: "Runs", go: "r" },
  { key: "projects", label: "Projects", go: "f" },
  { key: "agents", label: "Agents", go: "t" },
  { key: "workers", label: "Workers", go: "w" },
  { key: "graph", label: "Graph", go: "g" },
] as const;

export type NavItem = (typeof NAV)[number];
export type NavKey = NavItem["key"];
