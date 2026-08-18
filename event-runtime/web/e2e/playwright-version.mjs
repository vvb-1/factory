// Single source of truth for the pinned @playwright/test version.
// Imported by playwright.config.ts / e2e/server.mjs, and printed to stdout when
// executed directly (package.json `test:e2e` and .github/workflows/e2e.yml
// both read it that way) so the pin lives in exactly one place.
export const PLAYWRIGHT_VERSION = "1.62.1";

if (
  process.argv[1] &&
  new URL(`file://${process.argv[1]}`).pathname ===
    new URL(import.meta.url).pathname
) {
  process.stdout.write(`${PLAYWRIGHT_VERSION}\n`);
}
