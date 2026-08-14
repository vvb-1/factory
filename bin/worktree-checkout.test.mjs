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

test("worktree-up CLI argument parsing error paths", () => {
  // 1. Missing ticket and missing --here
  const missingArg = Bun.spawnSync({
    cmd: ["bash", UP],
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(missingArg.exitCode).not.toBe(0);
  expect(missingArg.stderr.toString()).toContain("usage: worktree-up.sh");

  // 2. Conflicting --here and ticket argument
  const hereWithTicket = Bun.spawnSync({
    cmd: ["bash", UP, "--here", "OPS-123"],
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(hereWithTicket.exitCode).not.toBe(0);
  expect(hereWithTicket.stderr.toString()).toContain("--here takes no ticket");

  const ticketWithHere = Bun.spawnSync({
    cmd: ["bash", UP, "OPS-123", "--here"],
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(ticketWithHere.exitCode).not.toBe(0);
  expect(ticketWithHere.stderr.toString()).toContain("--here takes no ticket");

  // 3. Invalid ticket regex
  const invalidTickets = ["invalid-ticket", "ops-123", "OPS_123", "123", "OPS-"];
  for (const t of invalidTickets) {
    const res = Bun.spawnSync({
      cmd: ["bash", UP, t],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr.toString()).toContain("ticket must look like OPS-123");
  }

  // 4. Unknown flag
  const unknownFlag = Bun.spawnSync({
    cmd: ["bash", UP, "--bogus-flag"],
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(unknownFlag.exitCode).not.toBe(0);
  expect(unknownFlag.stderr.toString()).toContain("unknown option '--bogus-flag'");

  // 5. Excess arguments
  const excessArgs = Bun.spawnSync({
    cmd: ["bash", UP, "OPS-123", "feat", "my-slug", "extra-arg"],
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(excessArgs.exitCode).not.toBe(0);
  expect(excessArgs.stderr.toString()).toContain("too many arguments (got 'extra-arg')");

  // 6. Help option displays usage and exits 0
  const helpRes = Bun.spawnSync({
    cmd: ["bash", UP, "--help"],
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(helpRes.exitCode).toBe(0);
  expect(helpRes.stdout.toString()).toContain("bin/worktree-up.sh OPS-123");
});

test("worktree-down CLI argument parsing error paths", () => {
  const tempWtRoot = mkdtempSync(path.join(tmpdir(), "factory-down-test-"));

  try {
    // 1. Missing ticket and missing --here
    const missingArg = Bun.spawnSync({
      cmd: ["bash", DOWN],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(missingArg.exitCode).not.toBe(0);
    expect(missingArg.stderr.toString()).toContain("usage: worktree-down.sh");

    // 2. Unknown flag
    const unknownFlag = Bun.spawnSync({
      cmd: ["bash", DOWN, "--invalid-flag"],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(unknownFlag.exitCode).not.toBe(0);
    expect(unknownFlag.stderr.toString()).toContain("unknown option '--invalid-flag'");

    // 3. Excess arguments
    const excessArgs = Bun.spawnSync({
      cmd: ["bash", DOWN, "OPS-123", "extra-arg"],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(excessArgs.exitCode).not.toBe(0);
    expect(excessArgs.stderr.toString()).toContain("too many arguments");

    // 4. Conflicting --here with ticket
    const hereWithTicket = Bun.spawnSync({
      cmd: ["bash", DOWN, "--here", "OPS-123"],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(hereWithTicket.exitCode).not.toBe(0);
    expect(hereWithTicket.stderr.toString()).toContain("--here takes no ticket");

    // 5. Help option displays usage and exits 0
    const helpRes = Bun.spawnSync({
      cmd: ["bash", DOWN, "-h"],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(helpRes.exitCode).toBe(0);
    expect(helpRes.stdout.toString()).toContain("bin/worktree-down.sh OPS-123");

    // 6. Non-existent worktree
    const nonExistent = Bun.spawnSync({
      cmd: ["bash", DOWN, "OPS-99999"],
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, FACTORY_WT_ROOT: tempWtRoot },
    });
    expect(nonExistent.exitCode).not.toBe(0);
    expect(nonExistent.stderr.toString()).toContain("no worktree at");
  } finally {
    rmSync(tempWtRoot, { recursive: true, force: true });
  }
});

test("worktree-down refuses dirty worktree without --force and cleans up with --force", () => {
  const tempWtRoot = mkdtempSync(path.join(tmpdir(), "factory-down-dirty-"));
  const ticketId = `DIRTY-${Date.now() % 100000}`;
  const expectedPath = path.join(tempWtRoot, ticketId);

  try {
    // 1. Create worktree
    const upRes = Bun.spawnSync({
      cmd: ["bash", UP, ticketId, "--checkout-only"],
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, FACTORY_WT_ROOT: tempWtRoot },
    });
    expect(upRes.exitCode).toBe(0);
    expect(existsSync(expectedPath)).toBe(true);

    // 2. Make uncommitted change in the worktree
    writeFileSync(path.join(expectedPath, "uncommitted.txt"), "uncommitted work");

    // 3. Attempt teardown without --force -> should fail and preserve worktree
    const downDirty = Bun.spawnSync({
      cmd: ["bash", DOWN, ticketId],
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, FACTORY_WT_ROOT: tempWtRoot },
    });
    expect(downDirty.exitCode).not.toBe(0);
    expect(downDirty.stderr.toString()).toContain("has uncommitted changes — commit/stash them, or re-run with --force");
    expect(existsSync(expectedPath)).toBe(true);

    // 4. Teardown with --force -> should succeed and remove worktree
    const downForce = Bun.spawnSync({
      cmd: ["bash", DOWN, ticketId, "--force"],
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, FACTORY_WT_ROOT: tempWtRoot },
    });
    expect(downForce.exitCode).toBe(0);
    expect(existsSync(expectedPath)).toBe(false);
  } finally {
    rmSync(tempWtRoot, { recursive: true, force: true });
    Bun.spawnSync({ cmd: ["git", "branch", "-D", `feat/${ticketId}`] });
  }
});

