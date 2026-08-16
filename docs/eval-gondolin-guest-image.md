# Gondolin guest image for coding agents

**Ticket:** WM-195  
**Status:** technical spike / implementation plan  
**Scope:** move the existing Claude Code and Pi adapters into the Gondolin boundary; no runtime implementation is part of this spike  
**Depends on:** [the corrected Gondolin evaluation](eval-gondolin-sandbox.md) and [event runtime §14.1](event-runtime.md#141-the-gondolin-microvm-sandbox-wm-185)

## 1. Decision

Build and pin a dedicated, architecture-specific Alpine guest image with Git,
Node, and the two agent CLIs pre-installed. Do not install tools at boot and do
not mount a runner's global CLI installation into the guest in production.
Every run gets:

- the repository worktree at `/workspace`;
- a fresh, non-persistent home and root filesystem;
- only explicitly declared read-only support mounts;
- an exact `allowedHosts` profile derived from its selected provider and
  declared tools; and
- either host-mediated credential placeholders or no credential at all.

The existing `command`-adapter sandbox remains the implementation baseline. It
already provides the hardware boundary, `RealFSProvider` mounts, default-deny
HTTP egress, host-side secret substitution, timeouts, and Node/Bun split. It
does **not** yet provide a coding-agent image, portable linked-worktree Git
metadata, guest stdin, subscription-token brokering, or Claude/Pi adapter
integration.

The production gate is stricter than “the CLI starts”: subscription credentials
must remain on the host. Copying or mounting a runner's complete `~/.claude.json`,
`~/.claude/`, or `~/.pi` into a model-controlled VM is acceptable only for a
throwaway compatibility probe with a dedicated test account. It is not the
target architecture.

## 2. Image contract

### 2.1 Base and packages

Use the same base family that Gondolin 0.12.0 runs today:

- Alpine Linux 3.23, one image for `aarch64` and one for `x86_64`;
- Node 24, while enforcing the strongest dependency floor (currently Node
  `>=23.6` for Gondolin's host SDK and `>=22.19` for the installed Pi package);
- a read-only, content-addressed base with an ephemeral copy-on-write root for
  each VM; and
- no package manager network access during a run.

The coding-agent image must contain this package set (some are already in Gondolin's base image):

| Package                | Why it is in the minimum image                                                                                                  |
| :--------------------- | :------------------------------------------------------------------------------------------------------------------------------ |
| `git`                  | Repository inspection, commits, diffs, and HTTPS push. The stock Gondolin image does not include it.                            |
| `bash`                 | Both harnesses and repository verification scripts assume Bash behavior in places; BusyBox `sh` is not a compatible substitute. |
| `coreutils`            | Stable GNU `env`, `timeout`, `realpath`, hashing, and file commands rather than a changing BusyBox subset.                      |
| `nodejs`, `npm`        | Runtime and deterministic installation format for the JavaScript CLI distributions.                                             |
| `ca-certificates`      | Provider and Git HTTPS must validate public roots plus Gondolin's injected mediation CA.                                        |
| `curl`                 | Image smoke tests and operator diagnostics; not required by adapter execution itself.                                           |
| `ripgrep`, `findutils` | Expected repository-search behavior for coding tasks and scripts.                                                               |
| `su-exec`              | Drop from boot-time root to the run's numeric UID/GID once UID mapping is implemented.                                          |

`openssh-client`, compilers, Python, and project build toolchains are optional
image profiles, not part of the agent minimum. Git over HTTPS is the paved road;
SSH requires Gondolin's separate host-terminated SSH policy and must not become
ambient egress. Repository-specific build dependencies belong in a declared
image profile or read-only toolchain mount, not an `apk add` performed by the
agent.

Build with Gondolin's supported custom-image flow (`gondolin build
--init-config`, then `gondolin build --config … --tag …`). The build runs in a
networked, audited image pipeline; runtime VMs remain offline except for their
policy. Publish the kernel/rootfs manifest, architecture, package lock or APK
index digest, CLI versions, image build ID, hashes, and SBOM together. The
agent definition or resolved `RunSpec` must select an immutable image build ID,
not `alpine-base:latest` or another mutable tag.

### 2.2 Git configuration

The image must not inherit or mount the host's `~/.gitconfig`. Give Git a
minimal system configuration:

```ini
[safe]
  directory = /workspace
[user]
  name = Factory Agent
  email = factory-agent@localhost
```

`safe.directory` is required because the guest initially runs as root while the
VFS reports the host files' numeric owner. The system author is a deterministic
fallback, not a claim about the human operator. A run that needs attributable
commits should receive trusted, non-secret `GIT_AUTHOR_NAME`,
`GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME`, and `GIT_COMMITTER_EMAIL` values from
the worker. Never infer identity from event input or copy credential helpers
from the host.

Before an image is admitted, smoke-test inside a real VM:

```sh
cd /workspace
git status --short
git diff --check
git config --get-all safe.directory
git config user.name
git config user.email
```

### 2.3 Agent CLI distribution

The ticket names `@mariozechner/pi`; that is not the package installed in the
runtime inspected for this spike. It uses Pi 0.84.1 from
`@earendil-works/pi-coding-agent`; its binary is `pi` and its package declares
Node `>=22.19`. Record the exact package used by the adapter rather than
silently relying on `npx pi`, whose resolution can change. Claude Code's image
artifact may use the supported `@anthropic-ai/claude-code` npm distribution,
but it must be tested against the host fleet's current native CLI behavior
before rollout.

Evaluate the three distribution mechanisms as follows:

| Mechanism                                                                        | Reproducibility                                                                 | Runtime egress                                                    | Host coupling                                   | Decision                              |
| :------------------------------------------------------------------------------- | :------------------------------------------------------------------------------ | :---------------------------------------------------------------- | :---------------------------------------------- | :------------------------------------ |
| Pre-bake pinned packages and their production dependency closure into the rootfs | High; image hash identifies all bytes                                           | None                                                              | None beyond guest architecture                  | **Production default**                |
| Mount a content-addressed CLI bundle read-only                                   | Medium; safe only with hashes and a guest-compatible Node/native-module closure | None                                                              | Architecture, libc, and mount layout must match | Prototype and emergency rollback only |
| Fetch/install on boot or populate an npm cache at first run                      | Low; registry and transitive metadata can move                                  | Requires `registry.npmjs.org` and possibly package-specific hosts | Mutable cache and lifecycle-script risk         | **Rejected for unattended runs**      |

Use `npm install --global --ignore-scripts` in the image build, pin exact package
versions and the resolved lock, then verify `claude --version` and `pi
--version` in both architectures. If either package later requires a lifecycle
script, treat that as an image-review change rather than dropping
`--ignore-scripts`. Put binaries at stable absolute paths such as
`/usr/local/bin/claude` and `/usr/local/bin/pi`; the current sandbox's array
execution deliberately does not search `PATH`.

The image must disable self-update and startup telemetry/version checks. Pi
supports `PI_OFFLINE=1`, which suppresses startup update, package-update, and
install telemetry traffic while still allowing the selected model provider.
For Claude Code, set the then-current documented updater/telemetry controls and
prove the resulting denied-host log is empty. Do not widen `allowedHosts` to
make an updater quiet.

## 3. Filesystem, identity, and integrity

### 3.1 Mounts

`event-runtime/lib/sandbox/runner.mjs` currently maps the host worktree through
`RealFSProvider` at `/workspace`. The provider canonicalizes its root and
rejects lexical traversal and followed symlinks that resolve outside that
root. Writes are executed by the host runner process, so new host files are
owned by the worker account even though the guest command currently runs as
`uid=0`. In a measured WM-195 VM, root saw a host-owned file as its real numeric
`501:20` owner and the stock image had no `git`.

The LLM profile narrows the generic mount feature:

- exactly one read-write repository mount at `/workspace`;
- an ephemeral guest home, cache, `/tmp`, and session directory;
- optional support mounts only from a registry-owned closed list, read-only by
  default; and
- no host home, `/`, runtime database, sibling worktree, SSH agent socket,
  Docker socket, `~/.config`, or global package directory.

Claude's strict MCP file and Pi extensions named by a pinned definition must be
baked into the image or mounted individually read-only under `/opt/factory`.
Host absolute paths currently passed by the adapters are not valid guest paths.

### 3.2 Linked worktrees are a separate problem

A Git linked worktree's `/workspace/.git` is normally a text file pointing to
an absolute administrative directory in the host's main checkout. Mounting only
the worktree therefore exposes the files but does **not** make Git functional
inside the guest. Mounting the main checkout's complete `.git` directory would
expose sibling worktrees and unrelated refs, violating the isolation claim.

The worker must prepare a per-run, self-contained Git directory outside the
repository files, mount it at `/run/factory/git`, and set:

```sh
GIT_DIR=/run/factory/git
GIT_WORK_TREE=/workspace
```

That Git directory must contain the pinned base commit, objects, intended branch
and remote without alternates that escape to a host path. After execution, the
host validates that the resulting head descends from the approved base, that
only the intended ref moved, and that repository changes satisfy the existing
Owned Paths and integrity gates. Only then may it reconcile the host worktree
ref or accept the pushed commit receipt. This preparation/reconciliation seam
must be designed with the event-runtime dispatch workspace owner; mounting the
main `.git` directory is not an interim shortcut.

### 3.3 UID/GID strategy

There is no magical UID translation in `RealFSProvider`; it reports host
metadata and performs I/O as the host Node process. The rollout has two steps:

1. **Compatibility:** run as guest root, keep `/workspace` as the only writable
   host mount, and rely on `safe.directory`. Host ownership remains the worker's
   because writes cross the VFS provider. Test modes, symlinks, hard links,
   renames, executable bits, and host umask explicitly.
2. **Target:** pass the worker's numeric UID/GID as trusted boot data, create or
   select a disposable `agent` identity with those numbers, and execute the CLI
   through `su-exec`. Refuse rather than fall back to root when the mapping
   cannot access the mount. Test macOS and Linux IDs, including a GID that
   already exists in Alpine.

The host integrity contract remains authoritative in both steps: capture the
base commit and pre-run status, reject path/symlink escapes, run the existing
post-run repository integrity and result-contract checks, and destroy the VM
and writable root after every attempt. VM isolation does not replace Owned
Paths verification or GitHub review.

## 4. Authentication

### 4.1 Configuration files are not safe mounts

Claude Code may use `~/.claude.json`, files under `~/.claude/`, or an OS-backed
credential store depending on its version and install method. Pi stores current
API-key and OAuth credentials in `~/.pi/agent/auth.json` (under the configurable
`PI_CODING_AGENT_DIR`); the broader `~/.pi` tree also contains settings,
sessions, packages, extensions, and trust decisions.

Do not mount either full tree. Apart from exposing bearer and refresh tokens,
that would import unrelated sessions, hooks, extensions, MCP configuration,
project trust, and mutable global state. A read-only OAuth file is also
operationally wrong when the CLI refreshes a token, while a read-write mount
lets the guest alter the runner's future authority.

For non-secret settings, generate a per-run home and copy only a schema-checked
allowlist. Pi should use a fresh `PI_CODING_AGENT_DIR` with offline/update
settings, explicit tools/extensions from the agent definition, and no prior
sessions. Claude should receive only the generated settings and strict MCP
configuration already owned by `claude.mjs`, translated to guest paths.

### 4.2 API-key mode: supported by today's placeholder mechanism

For an explicitly API-billed run, the existing Gondolin HTTP hooks can keep the
real key on the host. The guest receives a high-entropy placeholder in the
ordinary environment variable; the CLI puts it in the provider request; the
host replaces it only for that secret's declared host.

Claude or Pi using Anthropic directly:

```json
{
  "provider": "gondolin",
  "allowedHosts": ["api.anthropic.com"],
  "secrets": {
    "ANTHROPIC_API_KEY": {
      "env": "FACTORY_ANTHROPIC_API_KEY",
      "hosts": ["api.anthropic.com"]
    }
  }
}
```

Pi using an OpenAI API key:

```json
{
  "provider": "gondolin",
  "allowedHosts": ["api.openai.com"],
  "secrets": {
    "OPENAI_API_KEY": {
      "env": "FACTORY_OPENAI_API_KEY",
      "hosts": ["api.openai.com"]
    }
  }
}
```

This preserves the no-raw-secret invariant, but it changes billing and possibly
provider features. The current Factory adapters deliberately strip provider
API keys so subscription auth wins. API-key mode is therefore an explicit
policy/profile, not a transparent migration of current runs.

### 4.3 Subscription mode: broker before rollout

Raw subscription access and refresh tokens must also stay on the host. The
target is a host auth broker that:

1. reads and refreshes the host credential through a supported CLI/provider
   interface before VM launch;
2. gives the guest a synthetic, run-scoped access token with an expiry beyond
   the run deadline and no usable refresh token;
3. substitutes the real access token only for the selected provider host;
4. never serializes the real token into the VM request, workspace, transcript,
   logs, or artifacts; and
5. revokes its in-memory mapping at teardown.

A compatibility shim may generate a minimal guest auth file containing only the
synthetic access token if a CLI cannot consume it from an environment variable.
That file lives on the ephemeral guest root, never in `/workspace`. If the CLI
requires a refresh token or rewrites credentials, the broker must implement a
supported refresh seam; it must not copy the real refresh token. Private config
formats are versioned compatibility surfaces and need per-version tests.

For Pi's current providers, distinguish inference from interactive login:

- Anthropic inference: `api.anthropic.com`;
- OpenAI API-key inference: `api.openai.com`;
- ChatGPT/Codex subscription inference: `chatgpt.com`;
- OpenAI interactive login/refresh: `auth.openai.com`; and
- Pi Anthropic interactive login/refresh: `claude.ai` and
  `platform.claude.com`.

Interactive OAuth should normally happen on the host. A pre-refreshed brokered
run then needs only its inference host. Claude Code's exact subscription hosts
must be captured from a denied-egress compatibility run for the pinned CLI
version; do not guess and add broad wildcards. Subscription support is not
complete until both token refresh and an actual model turn pass while scans of
guest environment, process state, workspace, transcript, and rootfs find no
real credential.

### 4.4 Git and tool credentials

Model credentials do not authorize GitHub, Linear, npm, MCP servers, or arbitrary
agent tools. Add each service from declared capabilities. For example, an HTTPS
push may need `github.com` and a run-scoped `GIT_ASKPASS` helper that returns a
Gondolin placeholder; API calls through `gh` need `api.github.com`. Gondolin can
substitute placeholders inside Basic authorization, so the real GitHub token can
remain host-side. Do not mount `~/.config/gh`, `~/.ssh`, or
`SSH_AUTH_SOCK`.

## 5. Declarative egress profiles

`allowedHosts` is always explicit. Omitted and empty both mean deny-all in the
Factory policy, intentionally stricter than the upstream SDK. Entries are bare
hosts, not URLs. A secret's host set must be a subset of the run allowlist.
Redirects, WebSockets, and OAuth refreshes must remain subject to the same host
check.

Resolve the final list from a closed union:

```text
provider profile selected by model
+ services declared by capabilities
+ endpoints required by pinned, explicitly loaded MCP/extensions
= RunSpec allowedHosts
```

Do not add package registries, update services, telemetry, wildcard CDNs, or a
provider's entire parent domain. Image construction owns package downloads;
offline startup owns updater suppression. A denied-host audit event must name
the host without leaking request bodies or authorization headers. Compatibility
tests begin with deny-all, exercise one real model turn, add only observed and
documented required hosts, then assert an undeclared host still fails.

## 6. Adapter integration roadmap

### Phase 0 — image and compatibility matrix

- Add a reviewed Gondolin build config and produce pinned `aarch64`/`x86_64`
  images with the package contract above.
- Run Git and CLI smoke tests under real QEMU, including Alpine/musl native
  dependencies and deny-all startup.
- Record the exact Claude/Pi versions, binary hashes, provider hosts, expected
  denied optional hosts, and image build ID.
- Prove `/workspace` modes/ownership and the linked-worktree Git strategy.

**Exit:** both CLIs print structured output in a VM without runtime package
installation; no model credential is in the image.

### Phase 1 — sandbox transport shared by LLM adapters

- Extend `runner.mjs`/`runInSandbox()` with bounded stdin so Pi's prompt remains
  on stdin. Preserve Claude's and Pi's current prompt, structured stdout,
  transcript, usage, timeout, cancellation, and TERM-to-KILL semantics.
- Select an immutable guest image in normalized sandbox policy and preflight;
  never rely on the machine's mutable default image.
- Translate generated settings, strict MCP files, and definition-pinned Pi
  extensions to baked or individual read-only guest paths.
- Resolve `/usr/local/bin/claude` and `/usr/local/bin/pi` inside the guest and
  return typed image/CLI preflight failures.
- Keep host and guest execution behind one adapter-level transport seam so
  trace parsing and result verification cannot drift.

**Exit:** no-auth `--help`/fixture runs have parity with host execution and
teardown leaves no VM or writable root.

### Phase 2 — API-key end-to-end canary

- Generate provider-specific `allowedHosts` and placeholder policies from the
  resolved model, never from prompt/event text.
- Run one API-key canary per provider and scan guest state for the real key.
- Add negative tests for missing hosts, cross-host placeholder use, redirects,
  startup telemetry, and undeclared tool egress.

**Exit:** real model turns pass with only placeholders in the guest. This phase
is not permission to migrate subscription-backed production agents.

### Phase 3 — subscription broker and Git credentials

- Implement supported host-side credential readers/refreshers for the pinned
  Claude and Pi versions and synthetic per-run guest credentials.
- Add host-mediated GitHub HTTPS credentials and the portable per-run Git
  directory/reconciliation protocol.
- Test token expiry during a run, OAuth refresh failure, Git fetch/push, and
  teardown revocation without mounting host config.

**Exit:** current subscription-backed Claude and Pi runs, including a mutating
branch push, complete with no raw provider or Git credential in guest state.

### Phase 4 — staged adapter rollout

- Add `sandbox` to Claude/Pi definitions only after their image, auth, mounts,
  and network profile pass admission.
- Canary read-only agents first, then watched mutating worktree agents. Keep
  host execution as an explicit rollback during the canary, not an automatic
  fallback after sandbox failure.
- Compare result contracts, transcripts, usage, timeouts, repository integrity,
  boot latency, and denied-host events. Advertise `sandbox=gondolin-agent`
  placement only when the exact image and auth broker pass doctor checks.
- Remove host execution only after both architectures and subscription paths
  have sustained parity.

## 7. Required verification before adoption

The implementation tickets following this spike must add evidence for:

1. image reproducibility and signature/hash verification;
2. `git status`, diff, commit, and HTTPS push from a linked-worktree-derived
   workspace without mounting the main `.git` directory;
3. host/guest ownership, mode, symlink, hard-link, and traversal behavior;
4. one real Claude and Pi turn for every supported auth mode;
5. no real secret in guest environment, `/proc`, rootfs, workspace, transcript,
   stderr, or artifacts;
6. exact-host egress plus denied undeclared host, redirect, update, and telemetry
   traffic;
7. timeout, cancellation, process-tree cleanup, and VM teardown; and
8. byte-for-byte parity of `factory.agent-result/v1`, trace, usage, and post-run
   integrity behavior with the host adapters.

Until these gates pass, §14.1's scope statement remains true: only the
`command` adapter executes inside Gondolin; Claude and Pi remain host processes.
