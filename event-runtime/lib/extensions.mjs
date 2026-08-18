/**
 * Extensions — `factory-extension.json` (WM-838, docs/extensions.md).
 *
 * The factory has several extension surfaces but, before this module, no
 * extension *unit*: packs are allow-listed in `policy.yaml packs:` and loaded
 * by lib/registry.mjs, adapters are registered into the adapter registry
 * (lib/adapters/index.mjs), and nothing tied them together. An extension is
 * one directory with one manifest that declares what it contributes; this
 * loader feeds its packs into the existing pack machinery and its adapters
 * into the adapter registry. It builds no parallel path for either.
 *
 * Three properties this module owns:
 *
 *   1. **Discovery is allow-listed, never scanned.** Only the directories in
 *      `config/policy.yaml extensions:` are read, in policy order, mirroring
 *      `packs:` — an absent block loads nothing.
 *   2. **Failures are configuration anomalies, not crashes.** A missing or
 *      malformed manifest, a schema violation, a pack the registry would
 *      refuse, or an adapter that fails the contract records a
 *      `/status.anomalies.configuration` line (the artifact-view pattern,
 *      registry.mjs) and skips *that* extension whole — nothing of it is
 *      registered — while every other extension still loads. `serve`/`work`
 *      never fail to start because a third-party manifest is broken.
 *   3. **Reserved manifest keys are accepted, not rejected.** `connectors`,
 *      `views`, `panels` and `hooks` belong to follow-up tickets; a manifest
 *      that carries them loads its packs and adapters here and records a
 *      "not supported yet" anomaly for the rest.
 *   4. **Config is declared, validated, defaulted (WM-841).** An extension
 *      may declare `contributes.config: { namespace, schema }`; the operator's
 *      values live on the policy entry (`extensions[].config`). At load the
 *      schema is read, `default`s are applied, and the effective object is
 *      validated with lib/schema.mjs — a violation disables the extension
 *      (misconfigured code must not run). `getExtensionConfig(name)` hands the
 *      effective object to that extension's adapters/hooks/panels, and
 *      `loadedExtensions()` is the snapshot `GET /config` publishes.
 *
 * Ordering matters for callers: `adapterRegistry.toMap()` is a snapshot, so
 * `loadExtensions` must run before a CLI takes the map it hands to
 * lib/worker.mjs, and `result.packRoots` must be what `loadRegistry` is
 * given.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  ADAPTER_NAME_PATTERN,
  validateAdapterContract,
} from "./adapters/index.mjs";
import { RUNTIME_ROOT } from "./config.mjs";
import { RegistryError, loadPackRoots, loadRegistry } from "./registry.mjs";
import { expandHome, reposRoot } from "./repos.mjs";
import { validate } from "./schema.mjs";

export const EXTENSION_MANIFEST = "factory-extension.json";

export const EXTENSION_SCHEMA = JSON.parse(
  readFileSync(
    path.join(RUNTIME_ROOT, "schemas", "factory-extension.schema.json"),
    "utf8",
  ),
);

/** Manifest keys the schema accepts today but no ticket has implemented yet. */
export const RESERVED_CONTRIBUTIONS = Object.freeze([
  "connectors",
  "views",
  "panels",
  "hooks",
]);

/** Policy entry fields `extensions[]` accepts besides `path`. */
const ENTRY_FIELDS = new Set(["path", "config"]);

/**
 * The last `loadExtensions` result, kept so `getExtensionConfig` (adapters,
 * hooks, panels) and `GET /config` (lib/api-config.mjs) read the same effective
 * objects the loader validated. `serve` and `work` each load once at start.
 */
let LOADED = { extensions: [], disabled: [] };

/** Thrown only for a malformed `extensions:` policy block; per-extension faults are anomalies. */
export class ExtensionError extends Error {
  constructor(message) {
    super(message);
    this.name = "ExtensionError";
  }
}

function policyFile(root) {
  return path.join(root, "config", "policy.yaml");
}

function readPolicy(root) {
  const file = policyFile(root);
  if (!existsSync(file)) return {};
  try {
    return Bun.YAML.parse(readFileSync(file, "utf8")) ?? {};
  } catch (err) {
    throw new ExtensionError(
      `${file}: unparseable policy.yaml — ${err.message}`,
    );
  }
}

/**
 * Read the explicit extension allowlist from a parsed policy. No directory
 * discovery is ever performed: an absent block is the empty list. The block
 * itself must be well-formed (fail closed, like `packs:`); a malformed entry
 * is reported per entry so one typo does not hide the other extensions.
 *
 * @param {{ root?: string, policy?: object }} [options]
 * @returns {{ roots: Array<{ path: string, index: number, config?: object }>, anomalies: string[] }}
 *   `config` is the operator's raw values for the extension (validated by
 *   `loadExtensions` against the schema the manifest declares).
 */
export function loadExtensionRoots({ root = reposRoot(), policy } = {}) {
  const parsed = policy ?? readPolicy(root);
  const file = policyFile(root);
  const configured = parsed?.extensions;
  if (configured === undefined || configured === null)
    return { roots: [], anomalies: [] };
  if (!Array.isArray(configured))
    throw new ExtensionError(`${file}: "extensions" must be an array`);

  const roots = [];
  const anomalies = [];
  const seen = new Set();
  configured.forEach((entry, index) => {
    const at = `${file}: extensions[${index}]`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      anomalies.push(`${at} must be an object with path (entry skipped)`);
      return;
    }
    const unknown = Object.keys(entry).filter((key) => !ENTRY_FIELDS.has(key));
    if (unknown.length > 0) {
      anomalies.push(
        `${at}: unknown field${unknown.length > 1 ? "s" : ""} ${unknown.map((k) => `"${k}"`).join(", ")} (entry skipped)`,
      );
      return;
    }
    if (typeof entry.path !== "string" || entry.path.trim() === "") {
      anomalies.push(`${at}.path must be a non-empty string (entry skipped)`);
      return;
    }
    if (
      Object.hasOwn(entry, "config") &&
      (typeof entry.config !== "object" ||
        entry.config === null ||
        Array.isArray(entry.config))
    ) {
      anomalies.push(`${at}.config must be an object (entry skipped)`);
      return;
    }
    const resolved = path.resolve(root, expandHome(entry.path));
    if (seen.has(resolved)) {
      anomalies.push(`${at}: duplicate extension path ${resolved} (skipped)`);
      return;
    }
    seen.add(resolved);
    roots.push({
      path: resolved,
      index,
      ...(Object.hasOwn(entry, "config") ? { config: entry.config } : {}),
    });
  });
  return { roots, anomalies };
}

/**
 * Read and validate one manifest without loading anything it points at.
 * Path existence is checked (a pack directory or adapter file that is not
 * there is a manifest error, not a runtime surprise), but no pack is loaded
 * and no adapter module is imported — that is what `extensions validate` in
 * the CLI promises.
 *
 * @param {string} dir - the extension directory (the manifest's parent)
 * @returns {{ valid: boolean, errors: string[], warnings: string[], manifest: object|null, file: string }}
 */
export function validateExtensionManifest(dir) {
  const root = path.resolve(dir);
  const file = path.join(root, EXTENSION_MANIFEST);
  const errors = [];
  const warnings = [];
  const result = (manifest) => ({
    valid: errors.length === 0,
    errors,
    warnings,
    manifest,
    file,
  });
  if (!existsSync(file)) {
    errors.push(`missing ${EXTENSION_MANIFEST} in ${root}`);
    return result(null);
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    errors.push(`${file}: invalid JSON — ${err.message}`);
    return result(null);
  }
  const check = validate(EXTENSION_SCHEMA, manifest);
  if (!check.valid) {
    errors.push(...check.errors.map((e) => `${file}: ${e}`));
    return result(manifest);
  }

  const contributes = manifest.contributes ?? {};
  for (const key of RESERVED_CONTRIBUTIONS) {
    if (Object.hasOwn(contributes, key)) {
      warnings.push(
        `${file}: contributes.${key} is not supported yet (reserved; ignored)`,
      );
    }
  }
  const packs = new Set();
  for (const [i, rel] of (contributes.packs ?? []).entries()) {
    const abs = path.resolve(root, rel);
    if (!isInside(root, abs)) {
      errors.push(
        `${file}: contributes.packs[${i}] "${rel}" escapes the extension directory`,
      );
      continue;
    }
    if (packs.has(abs)) {
      errors.push(`${file}: contributes.packs[${i}] "${rel}" listed twice`);
      continue;
    }
    packs.add(abs);
    if (!existsSync(path.join(abs, "pack.json"))) {
      errors.push(
        `${file}: contributes.packs[${i}] "${rel}" has no pack.json (${abs})`,
      );
    }
  }
  for (const [name, rel] of Object.entries(contributes.adapters ?? {})) {
    if (!ADAPTER_NAME_PATTERN.test(name)) {
      errors.push(
        `${file}: contributes.adapters key "${name}" must match ${ADAPTER_NAME_PATTERN}`,
      );
      continue;
    }
    const abs = path.resolve(root, rel);
    if (!isInside(root, abs)) {
      errors.push(
        `${file}: contributes.adapters.${name} "${rel}" escapes the extension directory`,
      );
      continue;
    }
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      errors.push(
        `${file}: contributes.adapters.${name} "${rel}" is not a file (${abs})`,
      );
    }
  }
  if (contributes.config) {
    const rel = contributes.config.schema;
    const abs = path.resolve(root, rel);
    if (!isInside(root, abs)) {
      errors.push(
        `${file}: contributes.config.schema "${rel}" escapes the extension directory`,
      );
    } else if (!existsSync(abs) || !statSync(abs).isFile()) {
      errors.push(
        `${file}: contributes.config.schema "${rel}" is not a file (${abs})`,
      );
    }
  }
  return result(manifest);
}

/** Deep-clone JSON data (schema defaults are shared with the effective object otherwise). */
function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Fill `default`s from a schema into a value, recursively through
 * `properties`. A nested object property with no value is only created when
 * a default inside it produces something — an empty object would trip that
 * property's own `required` where absence would not.
 */
export function applyConfigDefaults(schema, value) {
  if (!isPlainObject(schema)) return cloneJson(value);
  let out = cloneJson(value);
  if (out === undefined) {
    if (Object.hasOwn(schema, "default")) out = cloneJson(schema.default);
    else if (schema.type === "object" || isPlainObject(schema.properties))
      out = {};
    else return undefined;
  }
  if (isPlainObject(out) && isPlainObject(schema.properties)) {
    for (const [key, sub] of Object.entries(schema.properties)) {
      if (Object.hasOwn(out, key)) {
        out[key] = applyConfigDefaults(sub, out[key]);
        continue;
      }
      const filled = applyConfigDefaults(sub, undefined);
      if (filled === undefined) continue;
      if (isPlainObject(filled) && Object.keys(filled).length === 0) continue;
      out[key] = filled;
    }
  }
  return out;
}

/** `default` is an annotation lib/schema.mjs does not know; strip it before validating. */
function withoutDefaults(schema) {
  if (Array.isArray(schema)) return schema.map(withoutDefaults);
  if (!isPlainObject(schema)) return schema;
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "default") continue;
    out[key] = withoutDefaults(value);
  }
  return out;
}

/**
 * Resolve one extension's effective config: read the declared schema, apply
 * its defaults over the operator's values, validate the result. Returns
 * `null` when the manifest declares no config and the policy gives none;
 * throws an ExtensionError naming the fault (and the failing value path)
 * otherwise, which `loadExtensions` turns into a disabling anomaly.
 *
 * @param {string} dir - the extension directory
 * @param {object} manifest - a schema-valid manifest
 * @param {object|undefined} values - the policy entry's `config`
 * @returns {{ namespace: string, schema: string, schemaJson: object, values: object }|null}
 */
export function resolveExtensionConfig(dir, manifest, values) {
  const declared = manifest.contributes?.config;
  if (!declared) {
    if (values !== undefined) {
      throw new ExtensionError(
        "policy.yaml gives config values but the manifest declares no contributes.config",
      );
    }
    return null;
  }
  const schemaFile = path.resolve(dir, declared.schema);
  let schemaJson;
  try {
    schemaJson = JSON.parse(readFileSync(schemaFile, "utf8"));
  } catch (err) {
    throw new ExtensionError(
      `contributes.config.schema "${declared.schema}" is not valid JSON — ${err.message}`,
    );
  }
  const effective = applyConfigDefaults(schemaJson, values ?? {});
  const check = validate(withoutDefaults(schemaJson), effective);
  if (!check.valid) {
    throw new ExtensionError(
      `config does not match ${declared.schema} — ${check.errors.join("; ")}`,
    );
  }
  return {
    namespace: declared.namespace,
    schema: declared.schema,
    schemaJson,
    values: effective,
  };
}

/**
 * The effective config object of a loaded extension — schema defaults applied
 * over the operator's policy values, validated at load. `undefined` when no
 * extension of that name loaded (unknown, or disabled by an anomaly).
 *
 * @param {string} name - the manifest `name` (`publisher/extension`)
 * @returns {object|undefined}
 */
export function getExtensionConfig(name) {
  return LOADED.extensions.find((e) => e.name === name)?.config?.values;
}

/**
 * Snapshot of the last `loadExtensions` run for read-only surfaces
 * (`GET /config`, lib/api-config.mjs): every accepted extension with its
 * config, and every extension a fault disabled with the reason.
 *
 * @returns {{
 *   extensions: Array<{ name: string, version: string, path: string, config: { namespace: string, schema: string, schemaJson: object, values: object }|null }>,
 *   disabled: Array<{ name: string|null, version: string|null, path: string, namespace: string|null, reason: string }>,
 * }}
 */
export function loadedExtensions() {
  return LOADED;
}

function isInside(root, abs) {
  const rel = path.relative(root, abs);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Read the pack name out of `pack.json`; the registry validates the rest. */
function packRootFor(extensionRoot, rel) {
  const packDir = path.resolve(extensionRoot, rel);
  const manifestFile = path.join(packDir, "pack.json");
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  } catch (err) {
    throw new RegistryError(`${manifestFile}: invalid JSON — ${err.message}`);
  }
  if (typeof manifest?.name !== "string" || manifest.name.trim() === "") {
    throw new RegistryError(`${manifestFile}: name must be a non-empty string`);
  }
  return { kind: "fs", name: manifest.name, path: packDir };
}

/**
 * Load every allow-listed extension: validate the manifest, prove its packs
 * load alongside everything accepted so far (a dry `loadRegistry`, so the
 * namespace/duplicate/pin/mutating rules of docs/kernel-and-packs.md apply
 * unchanged), import and contract-check its adapters, and only then — once
 * the whole extension is known good — register the adapters. A fault
 * anywhere skips the extension whole and records why.
 *
 * @param {object} [options]
 * @param {string} [options.root] - the checkout supplying `config/policy.yaml` (default: reposRoot())
 * @param {object} [options.policy] - an already-parsed policy object; when given, policy.yaml is not read
 * @param {ReturnType<import("./adapters/index.mjs").createAdapterRegistry>} [options.adapterRegistry] - where adapters go; when absent, adapters are validated but not registered
 * @param {Array<object>} [options.packRoots] - the policy `packs:` roots the extension packs join (default: loadPackRoots({ root }))
 * @param {string} [options.registryRoot] - the built-in registry root the dry load uses (tests point it at a copy)
 * @returns {Promise<{
 *   extensions: Array<{ name: string, version: string, path: string, packs: string[], adapters: string[], reserved: string[], config: { namespace: string, schema: string, values: object }|null }>,
 *   packRoots: Array<object>,
 *   anomalies: string[],
 *   disabled: Array<{ name: string|null, version: string|null, path: string, namespace: string|null, reason: string }>,
 * }>} `packRoots` is the full list — policy packs first, then every accepted
 *   extension pack in policy order — ready to hand to `loadRegistry`.
 *   `disabled` lists every extension an anomaly skipped, for `/config`.
 */
export async function loadExtensions({
  root = reposRoot(),
  policy,
  adapterRegistry,
  packRoots,
  registryRoot,
} = {}) {
  const basePackRoots = packRoots ?? loadPackRoots({ root });
  const { roots, anomalies } = loadExtensionRoots({ root, policy });
  const extensions = [];
  const accepted = [...basePackRoots];
  const acceptedPackNames = new Set(basePackRoots.map((p) => p.name));
  const acceptedAdapterNames = new Set();
  const acceptedNamespaces = new Map();
  const disabled = [];
  const loaded = [];
  const dryLoad = (candidates) =>
    loadRegistry({
      ...(registryRoot ? { root: registryRoot } : {}),
      packRoots: candidates,
    });

  for (const { path: dir, config: values } of roots) {
    const checked = validateExtensionManifest(dir);
    const skip = (reason) => {
      anomalies.push(`extension ${dir}: ${reason} (extension skipped)`);
      disabled.push({
        name: checked.manifest?.name ?? null,
        version: checked.manifest?.version ?? null,
        path: dir,
        namespace: checked.manifest?.contributes?.config?.namespace ?? null,
        reason,
      });
    };
    if (!checked.valid) {
      skip(checked.errors.join("; "));
      continue;
    }
    const manifest = checked.manifest;
    const label = `${manifest.name}@${manifest.version}`;
    const contributes = manifest.contributes ?? {};

    // Config: schema + defaults + validation, before any extension code is
    // imported — misconfigured code must not run (WM-841).
    let config;
    try {
      config = resolveExtensionConfig(dir, manifest, values);
    } catch (err) {
      skip(`${label}: ${err.message}`);
      continue;
    }

    // Packs: resolve to pack roots and prove they load with everything
    // accepted so far. The registry's own errors identify both packs on a
    // collision, which is the message an operator needs.
    let extPackRoots;
    try {
      extPackRoots = (contributes.packs ?? []).map((rel) =>
        packRootFor(dir, rel),
      );
      for (const pack of extPackRoots) {
        if (acceptedPackNames.has(pack.name)) {
          throw new RegistryError(
            `pack name "${pack.name}" is already configured (policy packs: or an earlier extension)`,
          );
        }
      }
      if (extPackRoots.length > 0) dryLoad([...accepted, ...extPackRoots]);
    } catch (err) {
      skip(`${label}: pack rejected — ${err.message}`);
      continue;
    }

    // Adapters: import, contract-check, and refuse names already taken.
    // Nothing is registered until every adapter of the extension passed.
    const modules = [];
    let adapterFault = null;
    for (const [name, rel] of Object.entries(contributes.adapters ?? {})) {
      if (adapterRegistry?.has(name) || acceptedAdapterNames.has(name)) {
        adapterFault = `adapter "${name}" is already registered (extensions may not replace an existing adapter)`;
        break;
      }
      const file = path.resolve(dir, rel);
      let module;
      try {
        module = await import(pathToFileURL(file).href);
      } catch (err) {
        adapterFault = `adapter "${name}" failed to import from ${file}: ${err.message}`;
        break;
      }
      try {
        validateAdapterContract(name, module);
      } catch (err) {
        adapterFault = err.message;
        break;
      }
      modules.push({ name, module });
    }
    if (adapterFault) {
      skip(`${label}: ${adapterFault}`);
      continue;
    }
    if (config && acceptedNamespaces.has(config.namespace)) {
      skip(
        `${label}: config namespace "${config.namespace}" is already used by ${acceptedNamespaces.get(config.namespace)}`,
      );
      continue;
    }

    // Accept: commit packs, register adapters, record the reserved keys.
    accepted.push(...extPackRoots);
    for (const pack of extPackRoots) acceptedPackNames.add(pack.name);
    for (const { name, module } of modules) {
      adapterRegistry?.register(name, module, { source: manifest.name });
      acceptedAdapterNames.add(name);
    }
    for (const warning of checked.warnings) anomalies.push(warning);
    if (config) acceptedNamespaces.set(config.namespace, manifest.name);
    const { schemaJson, ...publicConfig } = config ?? {};
    extensions.push({
      name: manifest.name,
      version: manifest.version,
      path: dir,
      packs: extPackRoots.map((p) => p.name),
      adapters: modules.map((m) => m.name),
      reserved: RESERVED_CONTRIBUTIONS.filter((key) =>
        Object.hasOwn(contributes, key),
      ),
      config: config ? publicConfig : null,
    });
    loaded.push({
      name: manifest.name,
      version: manifest.version,
      path: dir,
      config: config ? { ...publicConfig, schemaJson } : null,
    });
  }

  LOADED = { extensions: loaded, disabled };
  return { extensions, packRoots: accepted, anomalies, disabled };
}
