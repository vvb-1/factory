#!/usr/bin/env bun

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertPortFree, freePorts } from "./free-port.mjs";

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.resolve(webDir, "../..");

// Ports come from the environment when the Playwright config (or a human) has
// already chosen them; otherwise pick free ones. Never fall back to fixed
// numbers: another worktree's runtime may hold them, and seeding demo data
// into a foreign live runtime is the failure mode this guards against.
const envPort = (name) => {
  const raw = process.env[name];
  if (!raw) return undefined;
  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535)
    throw new Error(`${name}=${raw} is not a valid TCP port`);
  return port;
};
let apiPort = envPort("E2E_API_PORT");
let webPort = envPort("E2E_WEB_PORT");
if (apiPort === undefined || webPort === undefined) {
  const picked = await freePorts(2);
  apiPort ??= picked[0];
  webPort ??= picked[1];
}
if (webPort === apiPort)
  throw new Error(
    `E2E_API_PORT and E2E_WEB_PORT must differ (both ${apiPort})`,
  );
// Refuse to start on a port something else already answers on: /health has
// no identity, so a foreign runtime would otherwise pass the readiness check.
await assertPortFree(apiPort, "E2E API port");
await assertPortFree(webPort, "E2E web port");

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

function spawn(name, args, { cwd = root, env = runtimeEnv } = {}) {
  const child = Bun.spawn(args, {
    cwd,
    env,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  child.name = name;
  child.exitedWith = child.exited.then((code) => ({ name, code }));
  children.push(child);
  return child;
}

// Poll `url` until it answers 2xx, but fail fast if any of `watch` exits first:
// a child that died on startup (port taken, crash) must never let us proceed
// against whatever else happens to be listening on that port.
async function waitFor(url, label, watch = [], attempts = 200) {
  const died = Promise.race(watch.map((child) => child.exitedWith));
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const outcome = await Promise.race([
      died.then((exit) => ({ exit })),
      fetch(url).then(
        (response) => ({ response }),
        (error) => ({ error }),
      ),
    ]);
    if (outcome.exit)
      throw new Error(
        `${outcome.exit.name} exited (${outcome.exit.code}) before ${label} became ready at ${url}`,
      );
    if (outcome.response?.ok) {
      // A child that lost its port dies within its first few hundred ms while
      // the previous holder keeps answering. Give it a moment and make sure the
      // watched children are all still alive before trusting the reply.
      await Bun.sleep(250);
      const dead = watch.find((child) => child.exitCode !== null);
      if (dead)
        throw new Error(
          `${dead.name} exited (${dead.exitCode}) although ${label} answers at ${url} — is a foreign process listening there?`,
        );
      return;
    }
    lastError = outcome.response
      ? new Error(`HTTP ${outcome.response.status}`)
      : outcome.error;
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
    [...children].reverse().map(async (child) => {
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
    process.exit(exitCode);
  });
  return stopPromise;
}

process.on("SIGINT", () => void stop(130));
process.on("SIGTERM", () => void stop(0));

try {
  const api = spawn("control API", [
    "bun",
    "event-runtime/cli.mjs",
    "serve",
    "--adapter-override",
    "fake",
    "--port",
    String(apiPort),
  ]);
  const worker = spawn("worker", [
    "bun",
    "event-runtime/cli.mjs",
    "work",
    "--adapter-override",
    "fake",
  ]);

  await waitFor(`http://127.0.0.1:${apiPort}/health`, "control API", [
    api,
    worker,
  ]);

  const seed = spawn("demo seed", [
    "bun",
    "event-runtime/demo/seed.mjs",
    "--port",
    String(apiPort),
    "--prefix",
    `web-e2e-${process.pid}`,
    "--poll-ms",
    "100",
  ]);
  const seedExit = await Promise.race([
    seed.exitedWith,
    api.exitedWith,
    worker.exitedWith,
  ]);
  if (seedExit.name !== "demo seed")
    throw new Error(
      `${seedExit.name} exited (${seedExit.code}) during demo seed`,
    );
  if (seedExit.code !== 0) throw new Error(`demo seed exited ${seedExit.code}`);

  const vite = spawn(
    "Vite",
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
  await waitFor(`http://127.0.0.1:${webPort}`, "web UI", [api, worker, vite]);

  console.log(
    `e2e web UI ready on http://127.0.0.1:${webPort} (API ${apiPort})`,
  );

  const exited = await Promise.race([
    api.exitedWith,
    worker.exitedWith,
    vite.exitedWith,
  ]);
  if (!stopping)
    throw new Error(`${exited.name} exited unexpectedly (${exited.code})`);
} catch (error) {
  console.error(`e2e server: ${error instanceof Error ? error.stack : error}`);
  await stop(1);
}
