# Extensions

_Author guide for the malleable-factory epic (WM-834). This page is the one
reference for everything an extension can contribute; each follow-up ticket
appends its section here rather than opening a new document._

An **extension** is one directory with one manifest, `factory-extension.json`,
that declares everything the directory contributes to a running factory. It
is the unit an operator installs and enables — "the mobile pack + the argent
adapter" is one extension, enabled with one line, not two things installed two
ways.

Today an extension can contribute:

- **packs** — agent definitions, schemas, prompts, event types, edges and
  schedules, in the filesystem pack format of
  [`kernel-and-packs.md`](kernel-and-packs.md); they go through the same pack
  loader with the same namespace, duplicate, pin and `mutating` rules;
- **adapters** — harness adapters satisfying the contract in
  [`event-runtime-workers.md` §2c](event-runtime-workers.md#2c-adapter-registry-and-contract--shipped-wm-837);
  they are registered into the adapter registry with the extension's name as
  their `source`.

The manifest also **reserves** `connectors`, `views`, `panels`, `config` and
`hooks` for the tickets that land them (§Panels, §Config, §Hooks below). A
manifest that carries a reserved key loads its packs and adapters and records a
"not supported yet" configuration anomaly for the rest — it is accepted, not
rejected, so an extension written for a later runtime still does what this one
understands.

Implementation: `event-runtime/lib/extensions.mjs`, schema
`event-runtime/schemas/factory-extension.schema.json`, fixture
`event-runtime/test-support/extensions/sample/`.

## Layout

```text
~/.factory/extensions/wattmind-mobile/
  factory-extension.json      # the manifest — required
  pack/                       # a filesystem pack (pack.json, pins.json, agents/, schemas/, …)
  adapters/
    argent.mjs                # an adapter module (execute + SANDBOX_SUPPORT)
```

Nothing about the layout is fixed except the manifest's name and place: every
contributed path is written in the manifest, relative to the manifest's
directory, and must stay inside it.

## Manifest reference

```json
{
  "name": "wattmind/mobile",
  "version": "1.0.0",
  "description": "Mobile packs and the argent adapter",
  "factory": { "min": "0.x" },
  "contributes": {
    "packs": ["./pack"],
    "adapters": { "argent": "./adapters/argent.mjs" }
  }
}
```

| Key                                                                | Required | Meaning                                                                                                                                                                                                                                         |
| :----------------------------------------------------------------- | :------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                                                             | yes      | `publisher/extension`, matching `^[a-z0-9-]+/[a-z0-9-]+$`. Recorded as the `source` of every adapter the extension registers, so `bun event-runtime/cli.mjs adapters` can say where an adapter came from.                                       |
| `version`                                                          | yes      | Semver (`MAJOR.MINOR.PATCH`, optional pre-release/build).                                                                                                                                                                                       |
| `description`                                                      | no       | Up to 200 characters, for listings.                                                                                                                                                                                                             |
| `factory.min`                                                      | no       | The oldest factory the extension was written for. Informational until the runtime carries a version; the loader records it and does not enforce it.                                                                                             |
| `contributes.packs`                                                | no       | Array of relative directories, each containing a `pack.json`. The pack's `name` and `namespace` come from its own `pack.json` (`docs/kernel-and-packs.md` § Pack format) — the policy entry names the extension, not the pack.                  |
| `contributes.adapters`                                             | no       | Object `name → relative .mjs path`. Names must match the adapter pattern `^[a-z][a-z0-9-]*$`; the module must export `execute` and `SANDBOX_SUPPORT`. An extension may not replace an existing adapter (built-in or from an earlier extension). |
| `contributes.connectors`, `.views`, `.panels`, `.config`, `.hooks` | no       | **Reserved.** Accepted by the schema, ignored by the loader, reported as a configuration anomaly `contributes.<key> is not supported yet`.                                                                                                      |

Unknown top-level keys and unknown `contributes` keys are schema violations.
Validate a manifest without loading anything:

```sh
bun event-runtime/cli.mjs extensions validate ~/.factory/extensions/wattmind-mobile
# wattmind/mobile@1.0.0: valid (1 pack, 1 adapter)
```

`validate` checks the schema, that every contributed path exists and stays
inside the extension directory, and that adapter names are well-formed. It
does not load a pack or import an adapter module — running third-party code
is what enabling does.

## Trust model

There are two kinds of contribution, and the difference is what runs.

- **Data-only packs.** A pack is JSON and prose: definitions, schemas, prompts,
  routing maps. Loading one executes nothing. The kernel then holds it to the
  configured-pack rules — its own namespace, no shadowing of built-ins, pinned
  prompts and schemas, no `mutating: true` — so a pack can add agents but
  cannot widen what an agent may do. This is the surface an _agent_ may author
  (a dispatched ticket producing a pack is ordinary data), and it is why the
  fixture pack is a copy of `test-support/packs/sample`.
- **Operator-installed code.** An adapter is an ES module the worker imports
  and calls. Enabling an extension that contributes adapters is running that
  code in the worker process with the worker's credentials. Only the operator
  enables extensions — by editing `config/policy.yaml`, a committed file —
  and nothing an agent does at runtime can add one. The registry still puts
  every adapter behind the sandbox seam (an `unsupported` adapter is refused
  for a sandboxed definition before its code runs, WM-313/WM-837), and it
  refuses a module that does not satisfy the contract at load time rather
  than mid-run.

Two rules follow. Discovery is **allow-listed, never scanned**: the loader reads
only the directories `policy.yaml` names, in that order — dropping a directory
into `~/.factory/extensions/` does nothing on its own. And a broken extension is
a **configuration anomaly, not a crash**: a missing or malformed manifest, a
pack the registry would refuse, or an adapter that fails the contract skips
that extension whole (nothing of it is registered, not even its good parts),
records why under `/status.anomalies.configuration` (visible in `doctor`, the
web UI's status, and `extensions list`), and lets every other extension load.
`serve` and `work` never fail to start because of a third-party manifest.
The one thing that does fail closed is a malformed `extensions:` block itself
— an operator typo in the allowlist, exactly like `packs:`.

## Enabling an extension

Add its directory to `config/policy.yaml`:

```yaml
extensions:
  - path: ~/.factory/extensions/wattmind-mobile # must contain factory-extension.json
  - path: vendor/another-extension # relative paths resolve from the factory checkout
```

Each entry accepts only `path` (`~` expands to the home directory). Entries
load after the built-in root and after every `packs:` entry, in policy order:
`packRoots` handed to the registry is `packs:` first, then each accepted
extension's packs. Restart `serve` and the workers — extensions are read at
startup, alongside the registry.

Inspect what loaded:

```sh
bun event-runtime/cli.mjs extensions list          # name, version, pack/adapter counts, path; anomalies on stderr
bun event-runtime/cli.mjs extensions list --json   # { extensions, anomalies }
bun event-runtime/cli.mjs adapters                 # extension adapters appear with SOURCE = the extension name
```

An extension pack that duplicates a configured pack's name, or whose agents
collide with an already-loaded namespace, is refused with the registry's own
message naming both packs; fix the pack (or the order) and restart.

## Writing one

1. Create the directory and `factory-extension.json`; pick a `name` under your
   publisher prefix.
2. Add packs in the pack format (`kernel-and-packs.md`), each under its own
   `pack.json` with a non-empty `namespace`, and write its `pins.json`
   (`sha256:` of each prompt and schema, `kernel-and-packs.md` § Pins).
   `update-pins --pack <name>` reaches only `policy.yaml packs:` entries
   today; extension packs are pinned by hand until that command learns
   about extensions.
3. Add adapters as `.mjs` modules exporting `execute` and `SANDBOX_SUPPORT`;
   the smallest conformant module is
   `event-runtime/test-support/extensions/sample/adapters/echo.mjs`.
4. `bun event-runtime/cli.mjs extensions validate <dir>` until it is clean,
   enable it, `extensions list`, restart.

The fixture `event-runtime/test-support/extensions/sample/` is a complete,
loadable example, and `event-runtime/lib/extensions.test.mjs` shows every
failure mode and what the anomaly for it says.

## Panels

_Reserved key `contributes.panels` — lands in WM-840 (declarative
`factory.panel-view/v1` panels rendered on Overview). Until then the loader
accepts the key and reports it as not supported yet._

## Config

_Reserved key `contributes.config` — lands in WM-841 (extension config schemas
validated at load and surfaced in `/config` + Settings). Until then the loader
accepts the key and reports it as not supported yet._

## Hooks

_Reserved key `contributes.hooks` — lands in WM-842 (the `approve.before` hook
seam with persisted decisions). Until then the loader accepts the key and
reports it as not supported yet._

## Related

- [`kernel-and-packs.md`](kernel-and-packs.md) — the pack format and the
  kernel's admission rules, which extension packs inherit unchanged
- [`event-runtime-workers.md` §2c](event-runtime-workers.md#2c-adapter-registry-and-contract--shipped-wm-837) —
  the adapter contract and registry
- [`architecture.md`](architecture.md) — where extensions sit in the design
