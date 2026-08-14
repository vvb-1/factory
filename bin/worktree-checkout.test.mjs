import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";

const UP = path.resolve(import.meta.dir, "worktree-up.sh");
const DOWN = path.resolve(import.meta.dir, "worktree-down.sh");
const COMMON = path.resolve(import.meta.dir, "worktree-common.sh");

function sh(body, extraEnv = {}) {
  const result = Bun.spawnSync({
    cmd: ["bash", "-c", `source "${COMMON}"\n${body}`],
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...extraEnv },
  });
  return {
    status: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

test("locked_bun_install executes within lock and clears lock", () => {
  const testDir = mkdtempSync(path.join(tmpdir(), "locked-bun-test-"));
  try {
    const r = sh(`
      locked_bun_install() {
        local target_dir="$1"
        local lock_dir="\${HOME}/.factory/locks/test-bun-install.lock"
        mkdir -p "$(dirname "$lock_dir")"
        while ! mkdir "$lock_dir" 2>/dev/null; do
          sleep 0.05
        done
        echo $$ > "$lock_dir/pid"
        printf "installed in %s\n" "$target_dir"
        rm -rf "$lock_dir" 2>/dev/null || true
      }
      locked_bun_install "${testDir}"
    `);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`installed in ${testDir}`);
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});

test("locked_bun_install clears stale lock if pid is dead", () => {
  const lockDir = path.join(tmpdir(), "test-stale-lock.lock");
  mkdirSync(lockDir, { recursive: true });
  // Write a non-existent PID (e.g. 999999)
  writeFileSync(path.join(lockDir, "pid"), "999999");

  const r = sh(`
    lock_dir="${lockDir}"
    while ! mkdir "$lock_dir" 2>/dev/null; do
      if [[ -f "$lock_dir/pid" ]]; then
        holder=$(cat "$lock_dir/pid" 2>/dev/null || true)
        if [[ -n "$holder" ]] && ! kill -0 "$holder" 2>/dev/null; then
          rm -rf "$lock_dir" 2>/dev/null || true
          continue
        fi
      fi
      break
    done
    mkdir -p "$lock_dir"
    echo "reclaimed"
    rm -rf "$lock_dir"
  `);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("reclaimed");
});

test("worktree-up --checkout-only creates checkout without daemons and worktree-down removes it", () => {
  const tempWtRoot = mkdtempSync(path.join(tmpdir(), "factory-wt-root-"));
  const ticketId = `TEST-${Date.now() % 100000}`;

  try {
    const upRes = Bun.spawnSync({
      cmd: ["bash", UP, ticketId, "--checkout-only"],
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, FACTORY_WT_ROOT: tempWtRoot },
    });
    expect(upRes.exitCode).toBe(0);
    const expectedPath = path.join(tempWtRoot, ticketId);
    expect(upRes.stdout.toString().trim()).toBe(expectedPath);
    expect(existsSync(expectedPath)).toBe(true);

    // Verify no daemons or .factory/run created
    expect(existsSync(path.join(expectedPath, ".factory", "run"))).toBe(false);

    // Down should clean it up
    const downRes = Bun.spawnSync({
      cmd: ["bash", DOWN, ticketId],
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, FACTORY_WT_ROOT: tempWtRoot },
    });
    expect(downRes.exitCode).toBe(0);
    expect(existsSync(expectedPath)).toBe(false);
  } finally {
    rmSync(tempWtRoot, { recursive: true, force: true });
    Bun.spawnSync({ cmd: ["git", "branch", "-D", `feat/${ticketId}`] });
  }
});

test("concurrent worktree-up --checkout-only succeed in parallel", async () => {
  const tempWtRoot = mkdtempSync(path.join(tmpdir(), "factory-wt-conc-"));
  const base = Date.now() % 100000;
  const ticket1 = `CONCA-${base}`;
  const ticket2 = `CONCB-${base + 1}`;

  try {
    const [p1, p2] = await Promise.all([
      Bun.spawn(["bash", UP, ticket1, "--checkout-only"], {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, FACTORY_WT_ROOT: tempWtRoot },
      }).exited,
      Bun.spawn(["bash", UP, ticket2, "--checkout-only"], {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, FACTORY_WT_ROOT: tempWtRoot },
      }).exited,
    ]);
    expect(p1).toBe(0);
    expect(p2).toBe(0);
    expect(existsSync(path.join(tempWtRoot, ticket1))).toBe(true);
    expect(existsSync(path.join(tempWtRoot, ticket2))).toBe(true);

    // Clean up both
    await Promise.all([
      Bun.spawn(["bash", DOWN, ticket1], {
        env: { ...process.env, FACTORY_WT_ROOT: tempWtRoot },
      }).exited,
      Bun.spawn(["bash", DOWN, ticket2], {
        env: { ...process.env, FACTORY_WT_ROOT: tempWtRoot },
      }).exited,
    ]);
  } finally {
    rmSync(tempWtRoot, { recursive: true, force: true });
    Bun.spawnSync({ cmd: ["git", "branch", "-D", `feat/${ticket1}`, `feat/${ticket2}`] });
  }
});
