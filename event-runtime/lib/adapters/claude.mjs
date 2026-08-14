/**
 * Claude Code adapter (docs/event-runtime.md §6, §14; OPS-407) — the one real
 * registry entry. Spawns a bounded `claude -p` process with the workspace as
 * its cwd, enforces the run spec's timeout with the factory's shutdown discipline
 * (TERM, then KILL after 30s), strips ANTHROPIC_API_KEY so the CLI uses
 * subscription auth (docs/architecture.md §2.9), and confines tool access:
 *   - passes `--allowedTools` derived from `def.capabilities`, denying write tools
 *     when `mutating: false`
 *   - passes `--strict-mcp-config` and sets `CLAUDE_CONFIG_DIR` to an isolated
 *     runtime directory with no ambient MCP servers or global memory
 *
 * Output is `--output-format stream-json` (NDJSON; the CLI requires
 * `--verbose` with it in -p mode): the full raw stream is captured to
 * `.transcript.json` as the runtime transcript artifact, and each line is
 * additionally mapped to factory.trace/v1 events via the optional `onTrace`
 * callback so the operator can watch the agent live. Trace mapping is
 * best-effort — an unparseable or unrecognized line is ignored, never fatal.
 */
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

const KILL_GRACE_MS = 30_000;

/** Trace events preview text; the recorder's byte bound is the real limit. */
const TEXT_PREVIEW_CHARS = 4000;

const PROMPT_SUFFIX =
  "\n\n---\nInput is at ./input.json. Write ./result.json per the factory.agent-result/v1 contract. Work only inside this directory.";

export const READ_ONLY_TOOLS = ["Read", "Grep", "Glob"];
export const WRITE_TOOLS = new Set([
  "Write",
  "Edit",
  "Replace",
  "NotebookEdit",
  "Bash",
  "Kill",
  "DeleteFile",
  "CreateFile",
]);

/**
 * Derive allowed tools from definition capabilities and mutating flag (OPS-407).
 * When mutating is false, write tools are strictly forbidden.
 */
export function deriveAllowedTools(def) {
  if (def?.mutating === false) {
    if (Array.isArray(def?.capabilities?.tools)) {
      return def.capabilities.tools.filter((t) => !WRITE_TOOLS.has(t));
    }
    return [...READ_ONLY_TOOLS];
  }
  if (Array.isArray(def?.capabilities?.tools)) {
    return [...def.capabilities.tools];
  }
  return [...READ_ONLY_TOOLS];
}

/**
 * Build argv for spawning claude (OPS-407).
 * Enforces --allowedTools and --strict-mcp-config.
 */
export function buildClaudeArgv({ prompt, def, allowedTools = deriveAllowedTools(def) }) {
  const args = ["-p", prompt, "--output-format", "stream-json", "--verbose"];
  if (allowedTools && allowedTools.length > 0) {
    args.push("--allowedTools", allowedTools.join(","));
  }
  args.push("--strict-mcp-config");
  return args;
}

function clip(text) {
  const s = String(text ?? "");
  return s.length > TEXT_PREVIEW_CHARS ? `${s.slice(0, TEXT_PREVIEW_CHARS)}…[truncated]` : s;
}

/** Flatten a tool_result content value (string or content-block array) to text. */
function contentText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((block) => block?.type === "text")
      .map((block) => block.text ?? "")
      .join("\n");
  }
  return "";
}

/**
 * Map one parsed stream-json message to factory.trace/v1 events. Pure, so it
 * is unit-testable without spawning a model. One message can carry several
 * content blocks, hence an array (empty for anything unrecognized).
 *
 * @param {any} msg - one parsed NDJSON line from `claude -p --output-format stream-json`
 * @returns {Array<{kind: string, payload: object}>}
 */
export function mapStreamEvent(msg) {
  if (!msg || typeof msg !== "object") return [];

  if (msg.type === "assistant") {
    const blocks = msg.message?.content;
    if (!Array.isArray(blocks)) return [];
    const events = [];
    for (const block of blocks) {
      if (block?.type === "text" && block.text) {
        events.push({ kind: "assistant_text", payload: { text: clip(block.text) } });
      } else if (block?.type === "tool_use") {
        events.push({ kind: "tool_use", payload: { name: block.name, input: block.input } });
      }
    }
    return events;
  }

  if (msg.type === "user") {
    const blocks = msg.message?.content;
    if (!Array.isArray(blocks)) return [];
    const events = [];
    for (const block of blocks) {
      if (block?.type !== "tool_result") continue;
      const payload = { content: clip(contentText(block.content)) };
      if (block.is_error === true) payload.isError = true;
      events.push({ kind: "tool_result", payload });
    }
    return events;
  }

  if (msg.type === "result") {
    const usage = {};
    for (const key of ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"]) {
      if (typeof msg.usage?.[key] === "number") usage[key] = msg.usage[key];
    }
    return [
      {
        kind: "usage",
        payload: {
          durationMs: msg.duration_ms ?? null,
          numTurns: msg.num_turns ?? null,
          costUSD: msg.total_cost_usd ?? null,
          usage,
        },
      },
    ];
  }

  return []; // system/init, hooks, partials — not part of the trace contract
}

/**
 * @returns {Promise<{ exitCode: number | null, timedOut: boolean }>}
 */
export async function execute({ spec, def, workspaceDir, timeoutMs, env = {}, onTrace }) {
  const prompt = readFileSync(def.promptPath, "utf8") + PROMPT_SUFFIX;
  const configDir = path.join(workspaceDir, ".claude-config");
  mkdirSync(configDir, { recursive: true });

  const childEnv = { ...process.env, ...env, CLAUDE_CONFIG_DIR: configDir };
  delete childEnv.ANTHROPIC_API_KEY;

  const argv = buildClaudeArgv({ prompt, def });

  return new Promise((resolve, reject) => {
    const child = spawn("claude", argv, {
      cwd: workspaceDir,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Capture the CLI's structured output as a runtime artifact: the worker
    // collects .transcript.json into the §7 store, so the operator can read
    // what the agent reported long after the workspace is gone. With
    // stream-json the artifact is NDJSON, one message per line — consumers
    // stream bytes, none parses it as a single JSON document.
    const transcript = createWriteStream(path.join(workspaceDir, ".transcript.json"));
    child.stdout.pipe(transcript);

    // Live trace: same stdout, line by line. Every failure mode here is
    // swallowed — the agent must not be able to crash the worker via output.
    if (typeof onTrace === "function") {
      const lines = createInterface({ input: child.stdout });
      lines.on("line", (line) => {
        try {
          const parsed = JSON.parse(line);
          for (const event of mapStreamEvent(parsed)) {
            if (def?.mutating === false && event.kind === "tool_use" && WRITE_TOOLS.has(event.payload?.name)) {
              child.kill("SIGTERM");
            }
            onTrace(event.kind, event.payload);
          }
        } catch {
          // not JSON, or a recorder failure — ignore
        }
      });
    }

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
