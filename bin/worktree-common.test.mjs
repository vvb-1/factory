import { mkdtempSync, rmSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
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

async function shAsync(body, extraEnv = {}) {
  const proc = Bun.spawn(["bash", "-c", `source "${COMMON}"\n${body}`], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...extraEnv },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const status = await proc.exited;
  return { status, stdout, stderr };
}


test("ticket_api_port hashes the full id so N and N+200 do not share a slot", () => {
  const a = sh('ticket_api_port OPS-201');
  const b = sh('ticket_api_port OPS-401');
  expect(a.status).toBe(0);
  expect(b.status).toBe(0);
  expect(a.stdout).not.toBe(b.stdout);
  expect(Number(a.stdout) % 2).toBe(0);
  expect(Number(b.stdout) % 2).toBe(0);
});

test("ticket_api_port treats OPS-123 and OPS-123-scratch as different tickets", () => {
  const a = sh('ticket_api_port OPS-123');
  const b = sh('ticket_api_port OPS-123-scratch');
  expect(a.status).toBe(0);
  expect(b.status).toBe(0);
  expect(a.stdout).not.toBe(b.stdout);
});

test("write_ports / read_ports round-trip", () => {
  const wt = mkdtempSync(path.join(tmpdir(), "ops-460-ports-"));
  try {
    const written = sh(`write_ports "${wt}" 7752 7753\nread_ports "${wt}"`);
    expect(written.status).toBe(0);
    expect(written.stdout.trim()).toBe("7752 7753");
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

test("assert_event_home dies when /health belongs to another checkout", () => {
  const json = JSON.stringify({ env: { home: "/other/.factory/event-runtime" } });
  const r = sh(`assert_event_home '${json}' '/this/.factory/event-runtime' 7752`);
  expect(r.status).not.toBe(0);
  expect(r.stderr).toContain("refusing to seed");
  expect(r.stderr).toContain("/other/.factory/event-runtime");
});

test("assert_event_home accepts a matching env.home", () => {
  const home = "/this/.factory/event-runtime";
  const json = JSON.stringify({ env: { home } });
  const r = sh(`assert_event_home '${json}' '${home}' 7752`);
  expect(r.status).toBe(0);
});

test("assert_event_adapter requires fake unless --live", () => {
  const fake = JSON.stringify({ env: { adapter: "fake" } });
  const live = JSON.stringify({ env: {} });
  expect(sh(`assert_event_adapter '${fake}' 0 7752`).status).toBe(0);
  expect(sh(`assert_event_adapter '${live}' 1 7752`).status).toBe(0);
  const mismatch = sh(`assert_event_adapter '${fake}' 1 7752`);
  expect(mismatch.status).not.toBe(0);
  expect(mismatch.stderr).toContain("--live");
});

test("adapter_banner reports the /health adapter, not the local flag", () => {
  expect(sh('adapter_banner fake').stdout).toBe("(fake adapter — approvals are harmless)");
  expect(sh('adapter_banner ""').stdout).toBe("(live adapters)");
  expect(sh('adapter_banner claude').stdout).toBe("(adapter claude)");
});

test("allocate_api_port returns the preferred slot when nothing answers /health", () => {
  const r = sh('allocate_api_port 7752 /tmp/expected-home');
  expect(r.status).toBe(0);
  expect(r.stdout).toBe("7752");
});

test("allocate_api_port skips port occupied by another runtime", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 7760,
    fetch(req) {
      if (new URL(req.url).pathname === "/health") {
        return new Response(JSON.stringify({ ok: true, env: { home: "/other/worktree/.factory/event-runtime" } }), {
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  try {
    const r = await shAsync('allocate_api_port 7760 /this/worktree/.factory/event-runtime');
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("7762");
  } finally {
    server.stop(true);
  }
});

test("allocate_api_port skips port squatted by an alien process that does not answer /health", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 7764,
    fetch() {
      return new Response("I am an alien process", { status: 500 });
    },
  });
  try {
    const r = await shAsync('allocate_api_port 7764 /this/worktree/.factory/event-runtime');
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("7766");
  } finally {
    server.stop(true);
  }
});

test("allocate_api_port skips port held by raw TCP listener", async () => {
  const listener = Bun.listen({
    hostname: "127.0.0.1",
    port: 7772,
    socket: {
      data() {},
      open() {},
      close() {},
    },
  });
  try {
    const r = await shAsync('allocate_api_port 7772 /this/worktree/.factory/event-runtime');
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("7774");
  } finally {
    listener.stop(true);
  }
});

test("allocate_api_port reuses port when /health reports matching expected home", async () => {
  const home = "/this/worktree/.factory/event-runtime";
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 7774,
    fetch(req) {
      if (new URL(req.url).pathname === "/health") {
        return new Response(JSON.stringify({ ok: true, env: { home } }), {
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  try {
    const r = await shAsync(`allocate_api_port 7774 '${home}'`);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("7774");
  } finally {
    server.stop(true);
  }
});

test("port_listening detects active and closed ports", async () => {
  expect(sh('port_listening 7796').status).not.toBe(0);
  const listener = Bun.listen({
    hostname: "127.0.0.1",
    port: 7796,
    socket: {
      data() {},
      open() {},
      close() {},
    },
  });
  try {
    expect(sh('port_listening 7796').status).toBe(0);
  } finally {
    listener.stop(true);
  }
  expect(sh('port_listening 7796').status).not.toBe(0);
});

test("ticket_number extracts numeric ID from valid ticket strings", () => {
  expect(sh('ticket_number OPS-123').stdout.trim()).toBe("123");
  expect(sh('ticket_number CLNT-456').stdout.trim()).toBe("456");
  expect(sh('ticket_number WM-1').stdout.trim()).toBe("1");
  expect(sh('ticket_number OPS-999-scratch').stdout.trim()).toBe("999");
});

test("ticket_number dies on malformed ticket inputs", () => {
  const invalidCases = ["", "123", "ops-123", "OPS_123", "NO-DASH", "OPS-"];
  for (const input of invalidCases) {
    const r = sh(`ticket_number "${input}"`);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("ticket must look like OPS-123");
  }
});

test("web_build_hash computes deterministic sha1 and changes on file rename or content edit", () => {
  const mockWebDir = mkdtempSync(path.join(tmpdir(), "mock-web-build-"));
  try {
    const srcDir = path.join(mockWebDir, "src");
    const componentsDir = path.join(srcDir, "components");
    const publicDir = path.join(mockWebDir, "public");
    mkdirSync(componentsDir, { recursive: true });
    mkdirSync(publicDir, { recursive: true });

    writeFileSync(path.join(mockWebDir, "package.json"), JSON.stringify({ name: "mock-web" }));
    writeFileSync(path.join(mockWebDir, "bun.lock"), "lockfile-v1");
    writeFileSync(path.join(mockWebDir, "vite.config.ts"), "export default {};");
    writeFileSync(path.join(mockWebDir, "tsconfig.json"), "{}");
    writeFileSync(path.join(mockWebDir, "index.html"), "<!DOCTYPE html><html></html>");
    writeFileSync(path.join(srcDir, "main.ts"), "console.log('init');");
    writeFileSync(path.join(componentsDir, "Button.vue"), "<template><button>OK</button></template>");
    writeFileSync(path.join(publicDir, "favicon.ico"), "binary-icon-content");

    const initial = sh(`web_build_hash "${mockWebDir}"`);
    expect(initial.status).toBe(0);
    const initialHash = initial.stdout.trim();
    expect(initialHash).toMatch(/^[0-9a-f]{40}$/);

    // Identical hash on untouched directory
    const repeat = sh(`web_build_hash "${mockWebDir}"`);
    expect(repeat.stdout.trim()).toBe(initialHash);

    // 1. Content edit in src/
    writeFileSync(path.join(srcDir, "main.ts"), "console.log('updated');");
    const edited = sh(`web_build_hash "${mockWebDir}"`);
    expect(edited.stdout.trim()).not.toBe(initialHash);

    // Revert content edit -> restores initial hash
    writeFileSync(path.join(srcDir, "main.ts"), "console.log('init');");
    expect(sh(`web_build_hash "${mockWebDir}"`).stdout.trim()).toBe(initialHash);

    // 2. File rename in src/components/
    const oldBtn = path.join(componentsDir, "Button.vue");
    const newBtn = path.join(componentsDir, "Btn.vue");
    renameSync(oldBtn, newBtn);
    const renamed = sh(`web_build_hash "${mockWebDir}"`);
    expect(renamed.stdout.trim()).not.toBe(initialHash);

    // Revert rename -> restores initial hash
    renameSync(newBtn, oldBtn);
    expect(sh(`web_build_hash "${mockWebDir}"`).stdout.trim()).toBe(initialHash);

    // 3. Edit root config files
    writeFileSync(path.join(mockWebDir, "package.json"), JSON.stringify({ name: "mock-web-2" }));
    expect(sh(`web_build_hash "${mockWebDir}"`).stdout.trim()).not.toBe(initialHash);
  } finally {
    rmSync(mockWebDir, { recursive: true, force: true });
  }
});


