import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  HARNES_BLOCK,
  ensureHarnessGitignore,
  harnessGitignoreIsCurrent,
  spliceHarnessGitignore,
} from "./factory-gitignore.mjs";

test("appends harness block to empty gitignore", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "factory-gitignore-"));
  writeFileSync(path.join(dir, ".gitignore"), "", "utf8");
  expect(ensureHarnessGitignore(dir)).toBe("added");
  const out = readFileSync(path.join(dir, ".gitignore"), "utf8");
  expect(out).toContain(".claude/commands/factory-*.md");
  expect(harnessGitignoreIsCurrent(out)).toBe(true);
  rmSync(dir, { recursive: true, force: true });
});

test("is idempotent when block already present", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "factory-gitignore-"));
  writeFileSync(path.join(dir, ".gitignore"), `${HARNES_BLOCK}\n`, "utf8");
  expect(ensureHarnessGitignore(dir)).toBe("ok");
  rmSync(dir, { recursive: true, force: true });
});

test("accepts legalease-style hand-written rule as current", () => {
  const body = ".env\n.claude/commands/factory-*.md\n";
  expect(harnessGitignoreIsCurrent(body)).toBe(true);
});

test("splice replaces stale marked block", () => {
  const stale = `# FACTORY:HARNES:BEGIN\n.old\n# FACTORY:HARNES:END\n`;
  const out = spliceHarnessGitignore(stale);
  expect(out).toContain(".cursor/commands/factory-*.md");
  expect(harnessGitignoreIsCurrent(out)).toBe(true);
});
