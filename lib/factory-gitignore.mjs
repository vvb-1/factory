/**
 * Keep factory harness symlinks out of product repos.
 *
 * link-repos writes `.claude/commands/factory-*.md` symlinks locally; they must
 * never be committed — absolute paths, proprietary workflow, machine-specific.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const HARNES_BEGIN = "# FACTORY:HARNES:BEGIN";
export const HARNES_END = "# FACTORY:HARNES:END";

export const HARNES_BLOCK = `${HARNES_BEGIN}
# Local harness symlinks from \`factory emit\` — not repo content
.claude/commands/factory-*.md
.cursor/commands/factory-*.md
${HARNES_END}`;

/** True when gitignore already excludes factory command symlinks. */
export function harnessGitignoreIsCurrent(content) {
  const body = content ?? "";
  if (body.includes(HARNES_BEGIN) && body.includes(HARNES_END)) {
    return spliceHarnessGitignore(body) === body;
  }
  // Equivalent hand-written rules (legalease, coach-wattz patterns).
  if (/^\.claude\/commands\/factory-\*\.md\s*$/m.test(body)) return true;
  if (/^\.claude\/\s*$/m.test(body)) return true;
  return false;
}

/** Insert or refresh the marked block; append when no markers exist. */
export function spliceHarnessGitignore(existing) {
  const body = existing ?? "";
  const i = body.indexOf(HARNES_BEGIN);
  const j = body.indexOf(HARNES_END);
  if (i !== -1 && j !== -1 && j > i) {
    const before = body.slice(0, i);
    const after = body.slice(j + HARNES_END.length);
    const prefix = before.endsWith("\n") || !before ? before : `${before}\n`;
    const suffix = after.startsWith("\n") || !after.trim() ? after : `\n${after}`;
    return `${prefix}${HARNES_BLOCK}${suffix}`;
  }
  const sep = body.trim() ? body.replace(/\s*$/, "") + "\n\n" : "";
  return `${sep}${HARNES_BLOCK}\n`;
}

/**
 * Ensure repo/.gitignore excludes factory harness symlinks.
 * @returns {"ok"|"added"|"updated"|"skip"} 
 */
export function ensureHarnessGitignore(repoPath) {
  const file = path.join(repoPath, ".gitignore");
  if (!existsSync(file)) {
    writeFileSync(file, `${HARNES_BLOCK}\n`, "utf8");
    return "added";
  }
  const before = readFileSync(file, "utf8");
  if (harnessGitignoreIsCurrent(before)) return "ok";
  const after = spliceHarnessGitignore(before);
  if (after === before) return "ok";
  writeFileSync(file, after, "utf8");
  return before.includes(HARNES_BEGIN) ? "updated" : "added";
}
