import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
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
      "serve", "status", "ps", "runs", "proposals", "approve", "reject",
      "inject", "cancel", "retry", "inspect", "update-pins",
    ]) {
      expect(r.all).toContain(verb);
    }
    expect(r.all).toContain("usage:");
    expect(r.all).toContain("--watch");
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

  test("ps against a dead port says serve is not running, non-zero exit", () => {
    const r = runCli(["ps"], { FACTORY_EVENT_PORT: DEAD_PORT });
    expect(r.status).not.toBe(0);
    expect(r.all).toContain(
      `control API not reachable on 127.0.0.1:${DEAD_PORT} — start it with: bun event-runtime/cli.mjs serve`,
    );
  });

  test("serve --watch re-execs under bun --watch and binds", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "evrt-watch-"));
    const port = String(59000 + (process.pid % 800));
    const child = spawn("bun", [CLI, "serve", "--watch", "--port", port], {
      env: { ...process.env, FACTORY_EVENT_HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (b) => {
      out += b;
    });
    child.stderr.on("data", (b) => {
      out += b;
    });
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && !out.includes("control API on")) {
      await Bun.sleep(100);
    }
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
    expect(out).toContain("serve --watch: restarting on event-runtime/ changes");
    expect(out).toContain("control API on");
  });
});
