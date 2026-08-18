import { defineConfig } from "@playwright/test";

const apiPort = Number(process.env.E2E_API_PORT ?? 7391);
const webPort = Number(process.env.E2E_WEB_PORT ?? 7392);
const baseURL = `http://127.0.0.1:${webPort}`;

export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.e2e\.ts/,
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
