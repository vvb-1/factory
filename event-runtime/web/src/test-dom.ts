/**
 * Registers happy-dom globals for DOM component tests as an import side effect.
 *
 * Do not use a bunfig.toml `[test] preload`. bun only honours a preload when
 * `bun test` is run with that directory as cwd. Verification and CI run
 * `bun test event-runtime` from the repo root, so event-runtime/web/bunfig.toml
 * would be ignored and the test would die with `ReferenceError: document is
 * not defined`. A root-level preload would instead register DOM globals for
 * every pure-logic test in the sweep, which we do not want.
 *
 * Import this module first in every DOM test file so registration runs before
 * `@testing-library/react` (whose module-level `screen` binds to document.body
 * at import time). Use the queries returned by `render()`, not `screen`.
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
