import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("./cli.mjs", import.meta.url));

/** A loopback port nothing in these tests ever listens on. */
const DEAD_PORT = "59987";

function runCli(args, env = {}) {
  const home = mkdtempSync(path.join(os.tmpdir(), "evrt-cli-"));
  const result = spawnSync("bun", [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, FACTORY_EVENT_HOME: home, ...env },
  });
  return { ...result, all: `${result.stdout}${result.stderr}` };
}

describe("cli", () => {
  test("no command → usage text listing all verbs, non-zero exit", () => {
    const r = runCli([]);
    expect(r.status).not.toBe(0);
    for (const verb of [
      "serve", "status", "proposals", "approve", "reject",
      "inject", "cancel", "retry", "inspect", "update-pins",
    ]) {
      expect(r.all).toContain(verb);
    }
    expect(r.all).toContain("usage:");
  });

  test("unknown command → usage text, non-zero exit", () => {
    const r = runCli(["frobnicate"]);
    expect(r.status).not.toBe(0);
    expect(r.all).toContain("usage:");
  });

  test("status against a dead port says serve is not running, non-zero exit", () => {
    const r = runCli(["status"], { FACTORY_EVENT_PORT: DEAD_PORT });
    expect(r.status).not.toBe(0);
    expect(r.all).toContain(
      `control API not reachable on 127.0.0.1:${DEAD_PORT} — start it with: bun event-runtime/cli.mjs serve`,
    );
  });
});
