// The nav rail is a projection of the view registry (WM-839): one declaration
// per view in `views/registry.ts` drives the rail, the `g` chords, the ⌘K
// "Go to" actions, the lazy import and the route resolve. The chord rationale
// (which suffixes are taken and why) lives at the top of that file, and
// `views/registry.test.ts` enforces the collision rule. This module keeps the
// original import path working.
export {
  NAV,
  type NavGroup,
  type NavItem,
  type NavKey,
} from "./views/registry";
