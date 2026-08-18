import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

const e2eDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "e2e");

// Pick free ports once, in the runner process, and pin them into the
// environment. Playwright re-imports this config inside every worker process;
// the workers inherit the environment, so they see the same ports the
// webServer was started on instead of drawing fresh ones. Fixed defaults are
// deliberately avoided: several worktrees run on one host (WM-611 review).
if (!process.env.E2E_API_PORT || !process.env.E2E_WEB_PORT) {
  const [api, web] = execFileSync(
    process.execPath,
    [path.join(e2eDir, "free-port.mjs"), "2"],
    { encoding: "utf8" },
  )
    .trim()
    .split(/\s+/);
  process.env.E2E_API_PORT ||= api;
  process.env.E2E_WEB_PORT ||= web;
}

const apiPort = Number(process.env.E2E_API_PORT);
const webPort = Number(process.env.E2E_WEB_PORT);
const baseURL = `http://127.0.0.1:${webPort}`;

export default defineConfig({
  testDir: "./e2e",
  // `*.e2e.ts`, not `*.spec.ts`: bun test (root and web) discovers `*.spec.*`
  // and would try to run Playwright tests as unit tests.
  testMatch: /.*\.e2e\.ts$/,
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  outputDir: "./e2e/.test-results",
  reporter: process.env.CI
    ? [
        ["line"],
        ["html", { open: "never", outputFolder: "./e2e/.playwright-report" }],
      ]
    : "line",
  use: {
    baseURL,
    browserName: "chromium",
    channel: process.env.PLAYWRIGHT_CHANNEL ?? "chrome",
    headless: true,
    // The self-hosted shadow runner (and most container hosts) cannot run
    // Chromium's sandbox or fit its shared memory in /dev/shm (WM-670).
    launchOptions: { args: ["--no-sandbox", "--disable-dev-shm-usage"] },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "bun e2e/server.mjs",
    url: baseURL,
    timeout: 120_000,
    reuseExistingServer: false,
    env: {
      ...process.env,
      E2E_API_PORT: String(apiPort),
      E2E_WEB_PORT: String(webPort),
    },
  },
});
