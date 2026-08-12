/**
 * Claude Code adapter (docs/event-runtime.md §6) — the one real registry
 * entry. Spawns a bounded `claude -p` process with the workspace as its cwd,
 * enforces the run spec's timeout with the factory's shutdown discipline
 * (TERM, then KILL after 30s), and strips ANTHROPIC_API_KEY so the CLI uses
 * subscription auth (docs/architecture.md §2.9) — an event run must never
 * silently bill an API key that happens to be in the environment.
 */
import { spawn } from "node:child_process";
import { createWriteStream, readFileSync } from "node:fs";
import path from "node:path";

const KILL_GRACE_MS = 30_000;

const PROMPT_SUFFIX =
  "\n\n---\nInput is at ./input.json. Write ./result.json per the factory.agent-result/v1 contract. Work only inside this directory.";

/**
 * @returns {Promise<{ exitCode: number | null, timedOut: boolean }>}
 */
export async function execute({ spec, def, workspaceDir, timeoutMs, env = {} }) {
  const prompt = readFileSync(def.promptPath, "utf8") + PROMPT_SUFFIX;
  const childEnv = { ...process.env, ...env };
  delete childEnv.ANTHROPIC_API_KEY;

  return new Promise((resolve, reject) => {
    const child = spawn("claude", ["-p", prompt, "--output-format", "json"], {
      cwd: workspaceDir,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Capture the CLI's structured output as a runtime artifact: the worker
    // collects .transcript.json into the §7 store, so the operator can read
    // what the agent reported long after the workspace is gone.
    const transcript = createWriteStream(path.join(workspaceDir, ".transcript.json"));
    child.stdout.pipe(transcript);

    let timedOut = false;
    let killTimer;
    const termTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
      killTimer.unref?.();
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(termTimer);
      clearTimeout(killTimer);
      reject(err);
    });
    child.on("close", (exitCode) => {
      clearTimeout(termTimer);
      clearTimeout(killTimer);
      resolve({ exitCode, timedOut });
    });
  });
}
