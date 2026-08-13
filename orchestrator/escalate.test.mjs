import { test, expect, afterAll } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  EXIT,
  checkoutFreshness,
  freshnessWarnings,
  matchEscalations,
  resolveEscalateGlobs,
} from "./escalate.mjs";

const globs = ["app/src/payment/**", "app/src/auth/**", "app/migrations/**"];
const repos = Bun.YAML.parse(
  readFileSync(new URL("../config/repos.yaml", import.meta.url), "utf8"),
).repos;
const cashsaasGlobs = repos.find((repo) => repo.name === "cashsaas")?.escalate_paths;

test("cashsaas config protects its destructive, deployment, credential, and auth boundaries", () => {
  expect(cashsaasGlobs).toBeDefined();

  const hits = matchEscalations(
    [
      "schema.prisma",
      "migrations/20260804120000_remove_legacy_data/migration.sql",
      "Dockerfile",
      "docker-compose.yml",
      ".github/workflows/deploy.yml",
      ".env.example",
      "src/auth/verifyCurrentPassword.ts",
      "src/server/serverMiddleware.ts",
    ],
    cashsaasGlobs,
  );

  expect(hits.map((hit) => hit.file)).toEqual([
    "schema.prisma",
    "migrations/20260804120000_remove_legacy_data/migration.sql",
    "Dockerfile",
    "docker-compose.yml",
    ".github/workflows/deploy.yml",
    ".env.example",
    "src/auth/verifyCurrentPassword.ts",
    "src/server/serverMiddleware.ts",
  ]);
});

test("cashsaas config leaves ordinary dashboard, analytics, and docs changes unflagged", () => {
  expect(
    matchEscalations(
      [
        "src/dashboard/DashboardPage.tsx",
        "src/analytics/queries.ts",
        "docs/SESSION_HANDOFF.md",
        "README.md",
      ],
      cashsaasGlobs,
    ),
  ).toEqual([]);
});

test("flags a file under an escalate glob", () => {
  const hits = matchEscalations(["app/src/payment/stripe.ts"], globs);
  expect(hits.length).toBe(1);
  expect(hits[0].globs).toEqual(["app/src/payment/**"]);
});

test("clean diff passes", () => {
  expect(matchEscalations(["app/src/pages/Home.tsx", "README.md"], globs)).toEqual([]);
});

test("a single protected file among many still escalates", () => {
  const hits = matchEscalations(
    ["docs/notes.md", "app/migrations/0042_add_index.sql", "app/src/ui/Button.tsx"],
    globs,
  );
  expect(hits.map((h) => h.file)).toEqual(["app/migrations/0042_add_index.sql"]);
});

test("settings glob with wildcard filename matches", () => {
  const hits = matchEscalations(
    ["legalease/legalease/settings_prod.py"],
    ["legalease/legalease/settings*.py"],
  );
  expect(hits.length).toBe(1);
});

test("empty glob list never escalates", () => {
  expect(matchEscalations(["anything.ts"], [])).toEqual([]);
});

test("a missing escalate_paths key is not an empty list", () => {
  expect(resolveEscalateGlobs({ name: "unguarded" }).ok).toBe(false);
  expect(resolveEscalateGlobs({ name: "nulled", escalate_paths: null }).ok).toBe(false);
  expect(resolveEscalateGlobs({ name: "bad", escalate_paths: "src/auth/**" }).ok).toBe(false);
  expect(resolveEscalateGlobs({ name: "declared", escalate_paths: [] })).toEqual({ ok: true, globs: [] });
});

test("freshness warns when behind, when dirty, and when it cannot tell", () => {
  expect(freshnessWarnings({ upstream: "origin/main", behind: 0, dirtyConfig: false })).toEqual([]);

  const behind = freshnessWarnings({ upstream: "origin/main", behind: 2, dirtyConfig: false });
  expect(behind.length).toBe(1);
  expect(behind[0]).toContain("2 commit(s) behind origin/main");

  const dirty = freshnessWarnings({ upstream: "origin/main", behind: 0, dirtyConfig: true });
  expect(dirty.length).toBe(1);
  expect(dirty[0]).toContain("config/repos.yaml has uncommitted local changes");

  // A failed git command must read as "unknown", never as "clean".
  const unknown = freshnessWarnings({ upstream: null, behind: null, dirtyConfig: null });
  expect(unknown.length).toBe(2);
  expect(unknown[0]).toContain("cannot tell whether");
});

const tmp = mkdtempSync(path.join(tmpdir(), "factory-escalate-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const configPath = path.join(tmp, "repos.yaml");
writeFileSync(
  configPath,
  `repos:
  - name: guarded
    path: ~/Develop/guarded
    escalate_paths:
      - src/auth/**
      - migrations/**
  - name: declared-empty
    path: ~/Develop/declared-empty
    escalate_paths: []
  - name: unguarded
    path: ~/Develop/unguarded
`,
);

test("checkoutFreshness sees a locally modified config wherever it sits in the checkout", () => {
  const repo = mkdtempSync(path.join(tmp, "checkout-"));
  const git = (...args) => Bun.spawnSync({ cmd: ["git", "-C", repo, ...args], stdout: "pipe", stderr: "pipe" });
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  mkdirSync(path.join(repo, "config"));
  const cfg = path.join(repo, "config", "repos.yaml");
  writeFileSync(cfg, "repos: []\n");
  git("add", "-A");
  git("commit", "-qm", "init");

  expect(checkoutFreshness(cfg).dirtyConfig).toBe(false);
  appendFileSync(cfg, "# local edit\n");
  expect(checkoutFreshness(cfg).dirtyConfig).toBe(true);
  expect(freshnessWarnings(checkoutFreshness(cfg)).join("\n")).toContain("uncommitted local changes");
});

const CLI = path.join(import.meta.dir, "escalate.mjs");

function runCli(repo, files = []) {
  const result = Bun.spawnSync({
    cmd: ["bun", CLI, "--repo", repo, "--pr", "123"],
    env: {
      ...process.env,
      FACTORY_ESCALATE_REPOS_YAML: configPath,
      FACTORY_ESCALATE_DIFF_FILES: files.join("\n"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

test("escalate_paths present and a file matches => exit 2", () => {
  const result = runCli("guarded", ["docs/notes.md", "src/auth/session.ts"]);
  expect(result.exitCode).toBe(EXIT.ESCALATE);
  expect(result.stdout).toContain("ESCALATE");
  expect(result.stdout).toContain("src/auth/session.ts");
});

test("escalate_paths present and nothing matches => exit 0", () => {
  const result = runCli("guarded", ["src/dashboard/Page.tsx", "README.md"]);
  expect(result.exitCode).toBe(EXIT.CLEAN);
  expect(result.stdout).toContain("mechanical check clean");
});

test("no escalate_paths key => cannot evaluate, never exit 0", () => {
  const result = runCli("unguarded", ["src/auth/session.ts"]);
  expect(result.exitCode).not.toBe(EXIT.CLEAN);
  expect(result.exitCode).toBe(EXIT.CANNOT_EVALUATE);
  expect(result.stderr).toContain("CANNOT EVALUATE");
  expect(result.stderr).toContain("ESCALATED");
});

test("an explicitly empty escalate_paths list is a real answer => exit 0", () => {
  const result = runCli("declared-empty", ["src/auth/session.ts"]);
  expect(result.exitCode).toBe(EXIT.CLEAN);
  expect(result.stdout).toContain("explicitly empty");
});

test("an unknown repo cannot be evaluated either", () => {
  const result = runCli("not-a-repo", ["README.md"]);
  expect(result.exitCode).toBe(EXIT.CANNOT_EVALUATE);
  expect(result.stderr).toContain("CANNOT EVALUATE");
});
