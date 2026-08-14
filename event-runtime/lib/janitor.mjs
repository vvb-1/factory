import { spawn } from "node:child_process";
import path from "node:path";
import { reposRoot } from "./repos.mjs";

/** Bound so a hung Linear call cannot freeze serve forever (OPS-301 review). */
export const JANITOR_TIMEOUT_MS = 120_000;
export const JANITOR_MAX_BUFFER = 1_000_000;

/**
 * Argv for one repos.yaml name. `--force` is not a flag and must never become
 * one — the worktree_down refusal on dirty trees is the safety property.
 * Spawn runs against `reposRoot()` so FACTORY_REPOS_ROOT cannot survey one
 * yaml and tear down another.
 */
export function janitorArgv(name, { apply = false } = {}) {
  const args = [path.join(reposRoot(), "orchestrator", "janitor.mjs"), "--repo", name, "--json"];
  if (apply === true) args.push("--apply");
  return args;
}

/**
 * Spawn `orchestrator/janitor.mjs --json` for one repos.yaml name asynchronously (OPS-301, OPS-364).
 * Never passes `--force`. Injectable on createApi so tests never hit Linear
 * or real worktrees. Actor is the loopback operator — this is a host-side
 * spawn, the same trust as typing `factory janitor` on the machine.
 */
export async function spawnFactoryJanitor(
  name,
  { apply = false, timeoutMs = JANITOR_TIMEOUT_MS, maxBuffer = JANITOR_MAX_BUFFER } = {},
) {
  const args = janitorArgv(name, { apply });
  const root = reposRoot();

  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let killTimer = null;

    const child = spawn(process.execPath, args, {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {}
      killTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {}
      }, 2000);
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > maxBuffer) {
        try {
          child.kill("SIGKILL");
        } catch {}
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (stderr.length > maxBuffer) {
        try {
          child.kill("SIGKILL");
        } catch {}
      }
    });

    child.on("error", (err) => {
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);

      if (timedOut) {
        const err = new Error("janitor timed out");
        err.status = 504;
        return reject(err);
      }

      if (code === 2) {
        const err = new Error(`unknown repo ${name}`);
        err.status = 404;
        return reject(err);
      }

      if (code !== 0) {
        const err = new Error(stderr.trim() || `janitor exit ${code}`);
        err.status = 500;
        return reject(err);
      }

      let parsed;
      try {
        parsed = JSON.parse(stdout.trim());
      } catch (e) {
        const err = new Error(stderr.trim() || stdout.trim() || `invalid json: ${e.message}`);
        err.status = 500;
        return reject(err);
      }

      if (parsed && Array.isArray(parsed.results)) {
        const err = new Error("janitor returned multiple repos; expected one");
        err.status = 500;
        return reject(err);
      }

      resolve(parsed);
    });
  });
}
