/**
 * Unit tests for the pure stream-json → factory.trace/v1 mapper and CLI argument construction.
 * The adapter itself is never executed against real LLM in CI; fixtures mirror
 * the NDJSON shapes observed from `claude -p --output-format stream-json
 * --verbose` (message types system/assistant/user/result).
 */
import { describe, expect, test } from "bun:test";
import {
  buildClaudeArgv,
  deriveAllowedTools,
  mapStreamEvent,
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
      { kind: "tool_use", payload: { name: "Bash", input: { command: "ls" } } },
    ]);
  });

  test("user tool_result → tool_result, string and block-array content, isError", () => {
    const plain = mapStreamEvent({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "file.txt" }] },
    });
    expect(plain).toEqual([{ kind: "tool_result", payload: { content: "file.txt" } }]);

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
      { kind: "tool_result", payload: { content: "line 1\nline 2", isError: true } },
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

  test("filters out write tools when mutating is false even if requested in capabilities", () => {
    const def = {
      mutating: false,
      capabilities: {
        tools: ["Read", "Write", "Edit", "Grep", "Bash"],
      },
    };
    const tools = deriveAllowedTools(def);
    expect(tools).toEqual(["Read", "Grep"]);
    for (const tool of tools) {
      expect(WRITE_TOOLS.has(tool)).toBe(false);
    }
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
    expect(argv).toContain("Read,Grep,Glob");
    expect(argv).toContain("--mcp-config");
    expect(argv).toContain("/path/to/mcp.json");
    expect(argv).toContain("--strict-mcp-config");
  });
});
