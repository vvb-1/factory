import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildClaudeArgv,
  buildClaudeSettings,
  deriveAllowedTools,
  execute,
  KILL_GRACE_MS,
  mapStreamEvent,
  PROMPT_SUFFIX,
  READ_ONLY_TOOLS,
  WRITE_TOOLS,
} from "./claude.mjs";

describe("mapStreamEvent", () => {
  test("assistant text block → assistant_text", () => {
    const events = mapStreamEvent({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "Looking at the input now." }] },
      session_id: "s-1",
    });
    expect(events).toEqual([
      { kind: "assistant_text", payload: { text: "Looking at the input now." } },
    ]);
  });

  test("assistant tool_use block → tool_use; mixed blocks map in order", () => {
    const events = mapStreamEvent({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Running the query." },
          { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } },
        ],
      },
    });
    expect(events).toEqual([
      { kind: "assistant_text", payload: { text: "Running the query." } },
      { kind: "tool_use", payload: { id: "toolu_1", name: "Bash", input: { command: "ls" } } },
    ]);
  });

  test("user tool_result → tool_result, string and block-array content, isError", () => {
    const plain = mapStreamEvent({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "file.txt" }] },
    });
    expect(plain).toEqual([{ kind: "tool_result", payload: { content: "file.txt", toolUseId: "toolu_1" } }]);

    const blocks = mapStreamEvent({
      type: "user",
      message: {
        content: [{
          type: "tool_result",
          tool_use_id: "toolu_2",
          content: [{ type: "text", text: "line 1" }, { type: "text", text: "line 2" }],
          is_error: true,
        }],
      },
    });
    expect(blocks).toEqual([
      { kind: "tool_result", payload: { content: "line 1\nline 2", toolUseId: "toolu_2", isError: true } },
    ]);
  });

  test("final result → usage with only the token fields that exist", () => {
    const events = mapStreamEvent({
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 4321,
      duration_api_ms: 4000,
      num_turns: 3,
      total_cost_usd: 0.0421,
      usage: {
        input_tokens: 12,
        output_tokens: 345,
        cache_creation_input_tokens: 6789,
        cache_read_input_tokens: 1011,
        server_tool_use: { web_search_requests: 0 },
        service_tier: "standard",
      },
      result: "done",
    });
    expect(events).toEqual([{
      kind: "usage",
      payload: {
        durationMs: 4321,
        numTurns: 3,
        costUSD: 0.0421,
        usage: {
          input_tokens: 12,
          output_tokens: 345,
          cache_creation_input_tokens: 6789,
          cache_read_input_tokens: 1011,
        },
      },
    }]);
  });

  test("unrecognized messages are ignored silently", () => {
    expect(mapStreamEvent({ type: "system", subtype: "init", tools: [] })).toEqual([]);
    expect(mapStreamEvent({ type: "system", subtype: "hook_started" })).toEqual([]);
    expect(mapStreamEvent({ type: "stream_event", event: {} })).toEqual([]);
    expect(mapStreamEvent({ type: "assistant" })).toEqual([]); // no message body
    expect(mapStreamEvent({ type: "user", message: { content: "just a string" } })).toEqual([]);
    expect(mapStreamEvent(null)).toEqual([]);
    expect(mapStreamEvent("not an object")).toEqual([]);
  });

  test("very long assistant text is clipped, not passed through whole", () => {
    const [event] = mapStreamEvent({
      type: "assistant",
      message: { content: [{ type: "text", text: "y".repeat(10_000) }] },
    });
    expect(event.kind).toBe("assistant_text");
    expect(event.payload.text.length).toBeLessThan(5_000);
    expect(event.payload.text.endsWith("…[truncated]")).toBe(true);
  });
});

describe("deriveAllowedTools (OPS-407)", () => {
  test("defaults to read-only tools when mutating is false", () => {
    const def = { mutating: false };
    expect(deriveAllowedTools(def)).toEqual(READ_ONLY_TOOLS);
  });

  test("uses the workspace policy instead of a narrower tool declaration for mutating:false", () => {
    const def = {
      mutating: false,
      capabilities: { tools: ["Read", "Grep"] },
    };
    expect(deriveAllowedTools(def)).toEqual(READ_ONLY_TOOLS);
  });

  test("permits shell inspection and workspace-local output for non-mutating agents", () => {
    expect(deriveAllowedTools({ mutating: false })).toEqual(["Read", "Grep", "Glob", "Bash", "Write", "Edit"]);
  });

  test("allows requested tools when mutating is true", () => {
    const def = {
      mutating: true,
      capabilities: {
        tools: ["Read", "Write", "Bash"],
      },
    };
    expect(deriveAllowedTools(def)).toEqual(["Read", "Write", "Bash"]);
  });
});

describe("buildClaudeArgv (OPS-407, WM-62)", () => {
  test("generates a sandbox policy that permits output but denies repository writes", () => {
    const settings = buildClaudeSettings({
      spec: { workspace: { type: "repository", checkoutDir: "repo" } },
      def: { mutating: false },
      workspaceDir: "/private/tmp/run-a1",
    });
    expect(settings.permissions.allow).toEqual(READ_ONLY_TOOLS);
    expect(settings.permissions.deny).toEqual(["Edit(//private/tmp/run-a1/repo/**)"]);
    expect(settings.sandbox).toEqual({
      enabled: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      filesystem: { denyWrite: ["/private/tmp/run-a1/repo"] },
    });
  });

  test("constructs argv with --allowedTools, --mcp-config, and --strict-mcp-config", () => {
    const def = { mutating: false };
    const prompt = "Do a status check.";
    const argv = buildClaudeArgv({ prompt, def, mcpConfig: "/path/to/mcp.json" });

    expect(argv).toContain("-p");
    expect(argv).toContain(prompt);
    expect(argv).toContain("--output-format");
    expect(argv).toContain("stream-json");
    expect(argv).toContain("--verbose");
    expect(argv).toContain("--allowedTools");
    expect(argv).toContain("Read,Grep,Glob,Bash,Write,Edit");
    expect(argv).toContain("--mcp-config");
    expect(argv).toContain("/path/to/mcp.json");
    expect(argv).toContain("--strict-mcp-config");
  });
});

describe("execute conformance (OPS-427, docs/event-runtime.md §6)", () => {
  const tmpBase = realpathSync(mkdtempSync(path.join(tmpdir(), "evrt-claude-test-")));
  const stubBinDir = path.join(tmpBase, "bin");
  mkdirSync(stubBinDir, { recursive: true });

  const stubClaudePath = path.join(stubBinDir, "claude");
  const stubScript = `#!/usr/bin/env bun
import { writeFileSync } from "node:fs";

if (process.env.FACTORY_TEST_RECORD_FILE) {
  writeFileSync(
    process.env.FACTORY_TEST_RECORD_FILE,
    JSON.stringify({
      cwd: process.cwd(),
      env: process.env,
      argv: process.argv,
    }),
    "utf8",
  );
}

const behavior = process.env.FACTORY_TEST_BEHAVIOR || "normal";

if (behavior === "normal") {
  process.stdout.write(
    JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "Working..." }] },
    }) + "\\n",
  );
  process.stdout.write(
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      usage: { input_tokens: 15, output_tokens: 25 },
    }) + "\\n",
  );
  process.exit(0);
}

if (behavior === "exit_code") {
  const code = parseInt(process.env.FACTORY_TEST_EXIT_CODE || "1", 10);
  process.exit(code);
}

if (behavior === "sleep_sigterm") {
  setInterval(() => {}, 10_000);
}

if (behavior === "ignore_sigterm") {
  process.on("SIGTERM", () => {
    // deliberately ignore SIGTERM to test SIGKILL escalation
  });
  setInterval(() => {}, 10_000);
}

if (behavior === "emit_bash_then_success") {
  process.stdout.write(
    JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_bash", name: "Bash", input: { command: "pwd" } }] },
    }) + "\\n",
  );
  setTimeout(() => {
    process.stdout.write(JSON.stringify({ type: "result", usage: {} }) + "\\n");
    process.exit(0);
  }, 150);
}

if (behavior === "emit_policy_denial") {
  process.stdout.write(
    JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "touch repo/nope" } }],
      },
    }) + "\\n",
  );
  process.stdout.write(
    JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", is_error: true, content: "Sandbox denied write to repo/nope" }] },
    }) + "\\n",
  );
  process.exit(1);
}
`;
  writeFileSync(stubClaudePath, stubScript, { mode: 0o755 });

  const promptFile = path.join(tmpBase, "prompt.md");
  writeFileSync(promptFile, "You are a test agent.", "utf8");

  afterAll(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });

  const ws = () => realpathSync(mkdtempSync(path.join(tmpBase, "ws-")));
  const defaultDef = {
    ref: "test-agent@1",
    promptPath: promptFile,
    mutating: false,
    capabilities: { tools: ["Read", "Grep"] },
  };
  const defaultSpec = {
    agent: "test-agent@1",
    input: { repos: ["bj29"] },
  };

  test("executes stub binary in workspaceDir, strips ANTHROPIC_API_KEY, captures .transcript.json and trace", async () => {
    const workspaceDir = ws();
    const recordFile = path.join(workspaceDir, "record.json");
    const traceEvents = [];

    const outcome = await execute({
      spec: defaultSpec,
      def: defaultDef,
      workspaceDir,
      timeoutMs: 5000,
      env: {
        PATH: `${stubBinDir}${path.delimiter}${process.env.PATH}`,
        ANTHROPIC_API_KEY: "sk-secret-key-must-be-stripped",
        CLAUDECODE: "1",
        CLAUDE_CODE_ENTRYPOINT: "cli",
        CUSTOM_VAR: "custom_value",
        FACTORY_TEST_BEHAVIOR: "normal",
        FACTORY_TEST_RECORD_FILE: recordFile,
      },
      onTrace: (kind, payload) => traceEvents.push({ kind, payload }),
    });

    expect(outcome).toEqual({ exitCode: 0, timedOut: false, policyDenials: [] });

    // 1. Workspace confinement: cwd is workspaceDir
    expect(existsSync(recordFile)).toBe(true);
    const record = JSON.parse(readFileSync(recordFile, "utf8"));
    expect(record.cwd).toBe(workspaceDir);

    // 2. Env security: ANTHROPIC_API_KEY, CLAUDECODE, CLAUDE_CODE_ENTRYPOINT deleted
    expect(record.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(record.env.CLAUDECODE).toBeUndefined();
    expect(record.env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(record.env.CUSTOM_VAR).toBe("custom_value");

    // 3. Prompt & argv verification
    const promptIdx = record.argv.indexOf("-p");
    expect(promptIdx).toBeGreaterThan(-1);
    expect(record.argv[promptIdx + 1]).toBe(`You are a test agent.${PROMPT_SUFFIX}`);
    expect(record.argv).toContain("--output-format");
    expect(record.argv).toContain("stream-json");
    expect(record.argv).toContain("--verbose");
    expect(record.argv).toContain("--allowedTools");
    expect(record.argv).toContain("Read,Grep,Glob,Bash,Write,Edit");
    expect(record.argv).toContain("--settings");
    const policyPath = record.argv[record.argv.indexOf("--settings") + 1];
    const policy = JSON.parse(readFileSync(policyPath, "utf8"));
    expect(policy.sandbox.allowUnsandboxedCommands).toBe(false);
    expect(policy.permissions.allow).toEqual(READ_ONLY_TOOLS);
    expect(record.argv).toContain("--strict-mcp-config");

    // 4. .transcript.json artifact capture
    const transcriptPath = path.join(workspaceDir, ".transcript.json");
    expect(existsSync(transcriptPath)).toBe(true);
    const transcript = readFileSync(transcriptPath, "utf8");
    expect(transcript).toContain('"type":"assistant"');
    expect(transcript).toContain('"type":"result"');

    // 5. Live trace mapping
    expect(traceEvents).toHaveLength(2);
    expect(traceEvents[0].kind).toBe("assistant_text");
    expect(traceEvents[0].payload.text).toBe("Working...");
    expect(traceEvents[1].kind).toBe("usage");
    expect(traceEvents[1].payload.usage.input_tokens).toBe(15);
  });

  test("nonzero exit code propagates and timedOut is false", async () => {
    const workspaceDir = ws();
    const outcome = await execute({
      spec: defaultSpec,
      def: defaultDef,
      workspaceDir,
      timeoutMs: 5000,
      env: {
        PATH: `${stubBinDir}${path.delimiter}${process.env.PATH}`,
        FACTORY_TEST_BEHAVIOR: "exit_code",
        FACTORY_TEST_EXIT_CODE: "42",
      },
    });
    expect(outcome.exitCode).toBe(42);
    expect(outcome.timedOut).toBe(false);
  });

  test("timeout sends SIGTERM and returns timedOut: true", async () => {
    const workspaceDir = ws();
    const outcome = await execute({
      spec: defaultSpec,
      def: defaultDef,
      workspaceDir,
      timeoutMs: 150,
      killGraceMs: 5000,
      env: {
        PATH: `${stubBinDir}${path.delimiter}${process.env.PATH}`,
        FACTORY_TEST_BEHAVIOR: "sleep_sigterm",
      },
    });
    expect(outcome.timedOut).toBe(true);
  });

  test("timeout escalates to SIGKILL when child ignores SIGTERM", async () => {
    const workspaceDir = ws();
    const outcome = await execute({
      spec: defaultSpec,
      def: defaultDef,
      workspaceDir,
      timeoutMs: 100,
      killGraceMs: 100,
      env: {
        PATH: `${stubBinDir}${path.delimiter}${process.env.PATH}`,
        FACTORY_TEST_BEHAVIOR: "ignore_sigterm",
      },
    });
    expect(outcome.timedOut).toBe(true);
  });

  test("abortSignal terminates child process promptly with timedOut: false", async () => {
    const workspaceDir = ws();
    const ac = new AbortController();
    const runPromise = execute({
      spec: defaultSpec,
      def: defaultDef,
      workspaceDir,
      timeoutMs: 10_000,
      killGraceMs: 500,
      abortSignal: ac.signal,
      env: {
        PATH: `${stubBinDir}${path.delimiter}${process.env.PATH}`,
        FACTORY_TEST_BEHAVIOR: "sleep_sigterm",
      },
    });

    setTimeout(() => ac.abort(), 100);

    const outcome = await runPromise;
    expect(outcome.timedOut).toBe(false);
  });

  test("pre-aborted abortSignal terminates child immediately", async () => {
    const workspaceDir = ws();
    const ac = new AbortController();
    ac.abort();

    const outcome = await execute({
      spec: defaultSpec,
      def: defaultDef,
      workspaceDir,
      timeoutMs: 10_000,
      killGraceMs: 500,
      abortSignal: ac.signal,
      env: {
        PATH: `${stubBinDir}${path.delimiter}${process.env.PATH}`,
        FACTORY_TEST_BEHAVIOR: "sleep_sigterm",
      },
    });
    expect(outcome.timedOut).toBe(false);
  });

  test("does not turn a permitted Bash inspection into agent_exit_143", async () => {
    const traceEvents = [];
    const outcome = await execute({
      spec: defaultSpec,
      def: defaultDef,
      workspaceDir: ws(),
      timeoutMs: 5000,
      env: {
        PATH: `${stubBinDir}${path.delimiter}${process.env.PATH}`,
        FACTORY_TEST_BEHAVIOR: "emit_bash_then_success",
      },
      onTrace: (kind, payload) => traceEvents.push({ kind, payload }),
    });
    expect(outcome).toEqual({ exitCode: 0, timedOut: false, policyDenials: [] });
    expect(traceEvents.some((e) => e.kind === "tool_use" && e.payload.name === "Bash")).toBe(true);
  });

  test("records a policy denial without terminating the child from the trace observer", async () => {
    const workspaceDir = ws();
    const traceEvents = [];
    const outcome = await execute({
      spec: defaultSpec,
      def: { ...defaultDef, mutating: false },
      workspaceDir,
      timeoutMs: 5000,
      killGraceMs: 500,
      env: {
        PATH: `${stubBinDir}${path.delimiter}${process.env.PATH}`,
        FACTORY_TEST_BEHAVIOR: "emit_policy_denial",
      },
      onTrace: (kind, payload) => traceEvents.push({ kind, payload }),
    });

    expect(outcome).toEqual({
      exitCode: 1,
      timedOut: false,
      policyDenials: [{ tool: "Bash", rule: "Sandbox denied write to repo/nope" }],
    });
    expect(traceEvents.some((e) => e.kind === "lifecycle" && e.payload.note === "policy_denial" && e.payload.tool === "Bash")).toBe(true);
  });

  test("returns a policy denial even when no trace sink is attached", async () => {
    const outcome = await execute({
      spec: defaultSpec,
      def: defaultDef,
      workspaceDir: ws(),
      timeoutMs: 5000,
      env: {
        PATH: `${stubBinDir}${path.delimiter}${process.env.PATH}`,
        FACTORY_TEST_BEHAVIOR: "emit_policy_denial",
      },
    });
    expect(outcome.policyDenials).toEqual([{ tool: "Bash", rule: "Sandbox denied write to repo/nope" }]);
  });

  test("spawn error (e.g. claude not on PATH) rejects promise", async () => {
    const workspaceDir = ws();
    await expect(
      execute({
        spec: defaultSpec,
        def: defaultDef,
        workspaceDir,
        timeoutMs: 1000,
        env: { PATH: "/nonexistent-bin-dir" },
      }),
    ).rejects.toThrow();
  });
});
