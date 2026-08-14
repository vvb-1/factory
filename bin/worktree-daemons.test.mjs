import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";

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

test("spawn_daemon creates detached process that survives subshell exit", () => {
  const testDir = mkdtempSync(path.join(tmpdir(), "spawn-daemon-test-"));
  const pidfile = path.join(testDir, "test.pid");
  const logfile = path.join(testDir, "test.log");

  try {
    // Run spawn_daemon in a subshell that exits immediately
    const subshell = sh(`
      (
        spawn_daemon "${pidfile}" "${logfile}" "${testDir}" sleep 5
      )
      echo "subshell exited"
    `);
    expect(subshell.status).toBe(0);
    expect(subshell.stdout).toContain("subshell exited");
    expect(existsSync(pidfile)).toBe(true);

    const pid = readFileSync(pidfile, "utf8").trim();
    expect(Number(pid)).toBeGreaterThan(0);

    // Verify daemon is still alive
    const aliveCheck = sh(`pid_alive "${pidfile}"`);
    expect(aliveCheck.status).toBe(0);

    // Check process group using ps
    const ps = Bun.spawnSync({
      cmd: ["ps", "-o", "pid,pgid", "-p", pid],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(ps.exitCode).toBe(0);
    const psOut = ps.stdout.toString();
    expect(psOut).toContain(pid);

    // Stop daemon
    const stop = sh(`
      term_daemon "${pidfile}" "test daemon"
      await_daemon "${pidfile}" "test daemon"
    `);
    expect(stop.status).toBe(0);
    expect(existsSync(pidfile)).toBe(false);

    // Verify daemon is dead
    const deadCheck = sh(`pid_alive "${pidfile}"`);
    expect(deadCheck.status).not.toBe(0);
  } finally {
    if (existsSync(pidfile)) {
      try {
        const pid = readFileSync(pidfile, "utf8").trim();
        process.kill(Number(pid), "SIGKILL");
      } catch {}
    }
    rmSync(testDir, { recursive: true, force: true });
  }
});

test("term_daemon and await_daemon handle non-existent pidfile gracefully", () => {
  const r = sh(`
    term_daemon "/nonexistent/test.pid" "dummy"
    await_daemon "/nonexistent/test.pid" "dummy"
  `);
  expect(r.status).toBe(0);
});

test("pid_alive returns true for running process and false for dead process", () => {
  const testDir = mkdtempSync(path.join(tmpdir(), "pid-alive-test-"));
  const pidfile = path.join(testDir, "live.pid");

  try {
    // Write current test runner PID
    writeFileSync(pidfile, String(process.pid));
    // Should be alive
    const alive = sh(`pid_alive "${pidfile}"`);
    expect(alive.status).toBe(0);

    // Write a dead PID
    writeFileSync(pidfile, "999999");
    const dead = sh(`pid_alive "${pidfile}"`);
    expect(dead.status).not.toBe(0);
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});
