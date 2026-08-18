#!/usr/bin/env bun

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.resolve(webDir, "../..");
const apiPort = Number(process.env.E2E_API_PORT ?? 7391);
const webPort = Number(process.env.E2E_WEB_PORT ?? 7392);
const runtimeHome = mkdtempSync(path.join(tmpdir(), "factory-web-e2e-"));
const children = [];
let stopping = false;
let stopPromise;

const runtimeEnv = {
  ...process.env,
  FACTORY_EVENT_HOME: runtimeHome,
  FACTORY_EVENT_PORT: String(apiPort),
  FACTORY_EVENT_WEB_PORT: String(webPort),
};

function spawn(args, { cwd = root, env = runtimeEnv } = {}) {
  const child = Bun.spawn(args, {
    cwd,
    env,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  children.push(child);
  return child;
}

async function waitFor(url, label, attempts = 200) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await Bun.sleep(100);
  }
  throw new Error(
    `${label} did not become ready at ${url}: ${lastError?.message ?? "unknown error"}`,
  );
}

async function stop(exitCode = 0) {
  if (stopPromise) return stopPromise;
  stopping = true;
  stopPromise = Promise.all(
    children.reverse().map(async (child) => {
      try {
        child.kill("SIGTERM");
      } catch {
        // The child already exited.
      }
      const forceKill = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // The child exited before the cleanup deadline.
        }
      }, 5_000);
      try {
        await child.exited;
      } finally {
        clearTimeout(forceKill);
      }
    }),
  ).finally(() => {
    rmSync(runtimeHome, { recursive: true, force: true });
    process.exitCode = exitCode;
  });
  return stopPromise;
}

process.on("SIGINT", () => void stop(130));
process.on("SIGTERM", () => void stop(0));

try {
  const api = spawn([
    "bun",
    "event-runtime/cli.mjs",
    "serve",
    "--adapter-override",
    "fake",
    "--port",
    String(apiPort),
  ]);
  const worker = spawn([
    "bun",
    "event-runtime/cli.mjs",
    "work",
    "--adapter-override",
    "fake",
  ]);

  await waitFor(`http://127.0.0.1:${apiPort}/health`, "control API");

  const seed = spawn([
    "bun",
    "event-runtime/demo/seed.mjs",
    "--port",
    String(apiPort),
    "--prefix",
    `web-e2e-${process.pid}`,
    "--poll-ms",
    "100",
  ]);
  const seedCode = await seed.exited;
  if (seedCode !== 0) throw new Error(`demo seed exited ${seedCode}`);

  const vite = spawn(
    [
      path.join(webDir, "node_modules/.bin/vite"),
      "--host",
      "127.0.0.1",
      "--port",
      String(webPort),
      "--strictPort",
    ],
    { cwd: webDir, env: runtimeEnv },
  );
  await waitFor(`http://127.0.0.1:${webPort}`, "web UI");

  console.log(
    `e2e web UI ready on http://127.0.0.1:${webPort} (API ${apiPort})`,
  );

  const exited = await Promise.race([
    api.exited.then((code) => ({ name: "control API", code })),
    worker.exited.then((code) => ({ name: "worker", code })),
    vite.exited.then((code) => ({ name: "Vite", code })),
  ]);
  if (!stopping)
    throw new Error(`${exited.name} exited unexpectedly (${exited.code})`);
} catch (error) {
  console.error(`e2e server: ${error instanceof Error ? error.stack : error}`);
  await stop(1);
}
