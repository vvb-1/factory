/**
 * Deterministic test adapter (docs/event-runtime.md §6).
 *
 * Exercises every worker outcome — completion, refusal, contract violations,
 * crashes, timeouts, and workspace escape — without spawning a process or a
 * model. Behavior is selected by spec.input.repos[0], so the input still
 * validates against the real factory-status-report input schema and the rest
 * of the pipeline (planner, verifier, lifecycle) runs unmodified.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";

function writeResult(workspaceDir, result) {
  writeFileSync(
    path.join(workspaceDir, "result.json"),
    `${JSON.stringify(result, null, 2)}\n`,
    "utf8",
  );
}

function repoRow(name, overrides = {}) {
  return { name, triage: 1, agentReady: 2, inProgress: 0, blocked: 0, ...overrides };
}

/**
 * @returns {Promise<{ exitCode: number | null, timedOut: boolean }>}
 */
export async function execute({ spec, def, workspaceDir, timeoutMs, env }) {
  const mode = spec.input?.repos?.[0];

  switch (mode) {
    case "refuse":
      writeResult(workspaceDir, {
        schemaVersion: "factory.agent-result/v1",
        terminalState: "refused",
        reasonCode: "needs_human",
      });
      return { exitCode: 0, timedOut: false };

    case "invalid-artifact":
      // Violates the output schema: negative count and missing recommendedAction.
      writeResult(workspaceDir, {
        schemaVersion: "factory.agent-result/v1",
        terminalState: "completed",
        artifact: { repos: [repoRow(mode, { triage: -1 })] },
      });
      return { exitCode: 0, timedOut: false };

    case "no-result":
      return { exitCode: 0, timedOut: false };

    case "crash":
      return { exitCode: 1, timedOut: false };

    case "hang":
      // Resolves only when the timeout fires — no real long sleep in tests.
      await new Promise((resolve) => setTimeout(resolve, timeoutMs));
      return { exitCode: null, timedOut: true };

    case "escape":
      writeFileSync(path.resolve(workspaceDir, "..", "outside.txt"), "escaped\n", "utf8");
      writeResult(workspaceDir, {
        schemaVersion: "factory.agent-result/v1",
        terminalState: "completed",
        artifact: { repos: [repoRow(mode)], recommendedAction: "dispatch" },
        artifacts: [{ kind: "log", path: "../outside.txt" }],
      });
      return { exitCode: 0, timedOut: false };

    default:
      writeResult(workspaceDir, {
        schemaVersion: "factory.agent-result/v1",
        terminalState: "completed",
        artifact: { repos: [repoRow(mode ?? "unknown")], recommendedAction: "dispatch" },
        evidence: { queries: ["fake"] },
      });
      return { exitCode: 0, timedOut: false };
  }
}
