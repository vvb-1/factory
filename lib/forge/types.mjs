/**
 * Forge connector — the factory's one surface for the code host (WM-836).
 *
 * "Forge" is the neutral word for GitHub / GitLab / Gitea: the thing that
 * holds pull requests, workflow runs and a REST API. Everything outside
 * `lib/forge/` speaks this vocabulary (`pr`, `workflowRun`) and never spawns
 * `gh` itself; `github.mjs` owns the `gh` specifics and `memory.mjs` is the
 * in-process fake the contract suite and the demo run against.
 *
 * The interface is trimmed to what call sites actually use today. It grows
 * when a call site needs a verb, not before — do not design for imagined
 * forges here.
 *
 * Error contract: every method either returns the parsed answer or throws a
 * {@link ForgeError} carrying the exit `status` and the forge's `stderr`. Call
 * sites that used to treat "gh failed" as `null`/`[]` do so with one
 * try/catch; the ones that need the diagnostic (actions-cache, escalate,
 * planner) read it off the error.
 */

/**
 * Identifies a repository on the forge. `null` means "whatever the working
 * directory's checkout points at" — the GitHub implementation then omits
 * `--repo` and relies on `opts.cwd`, exactly as the pre-forge call sites did.
 * @typedef {string|null} RepoRef  `owner/name` or null
 */

/**
 * @typedef {object} ForgeCallOpts
 * @property {string} [cwd]     working directory for the underlying command
 * @property {number} [timeout] milliseconds before the command is killed
 */

/**
 * @typedef {ForgeCallOpts & { fields?: string[] }} PrViewOpts
 *   `fields` selects the JSON fields returned (GitHub: `--json a,b`).
 */

/**
 * @typedef {ForgeCallOpts & {
 *   state?: "open"|"closed"|"merged"|"all",
 *   limit?: number,
 *   fields?: string[],
 * }} PrListOpts
 */

/**
 * @typedef {ForgeCallOpts & {
 *   branch?: string,
 *   created?: string,   // GitHub `--created` filter, e.g. ">=2026-08-01"
 *   limit?: number,
 *   fields?: string[],
 * }} RunListOpts
 */

/**
 * @typedef {ForgeCallOpts & { jq?: string }} ApiRawOpts
 *   `jq` post-filters the response on the forge side (GitHub: `--jq`); the
 *   result is then the filter's text output, not JSON.
 */

/**
 * @typedef {object} ForgeCli
 * @property {string|null} bin      executable the implementation shells out to
 *                                  (`gh`), or null when it needs none
 * @property {string|null} install  one-line fix shown by doctor when it is missing
 */

/**
 * @typedef {object} Forge
 * @property {"github"|"memory"} kind
 * @property {ForgeCli} cli
 * @property {(repo: RepoRef, number: number|string, opts?: PrViewOpts) => object} prView
 *   One pull request as an object with the requested `fields`.
 * @property {(repo: RepoRef, opts?: PrListOpts) => object[]} prList
 *   Pull requests matching the filter, each with the requested `fields`.
 * @property {(repo: RepoRef, number: number|string, opts?: ForgeCallOpts) => string[]} prDiffFiles
 *   Paths changed by the pull request (one per entry, trimmed, no blanks).
 * @property {(repo: RepoRef, number: number|string, draft: boolean, opts?: ForgeCallOpts) => void} prSetDraft
 *   Convert the pull request to draft (`true`) or mark it ready (`false`).
 * @property {(repo: RepoRef, number: number|string, body: string, opts?: ForgeCallOpts) => void} prComment
 *   Post a comment on the pull request.
 * @property {(repo: RepoRef, opts?: RunListOpts) => object[]} runList
 *   Workflow runs matching the filter, each with the requested `fields`.
 * @property {(path: string, opts?: ApiRawOpts) => string} apiRaw
 *   Escape hatch: raw REST call, returns the response body as text.
 */

/** Thrown by every Forge method when the forge could not answer. */
export class ForgeError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number|null, stdout?: string, stderr?: string, cause?: unknown }} [details]
   */
  constructor(
    message,
    { status = null, stdout = "", stderr = "", cause } = {},
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ForgeError";
    /** Exit status of the underlying command, or null when it never ran. */
    this.status = status;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

/** Implementations `loadForge()` knows how to select. */
export const FORGE_KINDS = Object.freeze(["github", "memory"]);
