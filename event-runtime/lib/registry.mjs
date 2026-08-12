/**
 * Registered agent definitions and event-type mappings
 * (docs/event-runtime.md §5.4, §6).
 *
 * An inbound event may only select what is registered here. Definitions pin
 * their prompt and schema files by content hash: editing a pinned file
 * without bumping the version fails at load, closed. The run spec's git-SHA
 * promptVersion is provenance recorded at planning time, not a second
 * identity.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { hashBytes } from "./canonical.mjs";
import { RUNTIME_ROOT } from "./config.mjs";

export class RegistryError extends Error {
  constructor(message) {
    super(message);
    this.name = "RegistryError";
  }
}

const PINNED_FIELDS = ["prompt", "input_schema", "output_schema"];

function loadAgentDef(root, file) {
  const def = JSON.parse(readFileSync(file, "utf8"));
  for (const field of ["id", "version", ...PINNED_FIELDS, "workspace", "capabilities", "limits"]) {
    if (def[field] === undefined) throw new RegistryError(`${file}: missing "${field}"`);
  }
  if (def.mutating !== false) {
    throw new RegistryError(`${file}: mutating agents are not admitted in the MVP (docs/event-runtime.md §3)`);
  }
  const pins = def.pins ?? {};
  for (const field of PINNED_FIELDS) {
    const rel = def[field];
    const abs = path.join(root, rel);
    const actual = hashBytes(readFileSync(abs));
    if (!pins[rel]) throw new RegistryError(`${file}: "${rel}" has no pin — run: bun event-runtime/cli.mjs update-pins`);
    if (pins[rel] !== actual) {
      throw new RegistryError(
        `${file}: "${rel}" content ${actual} does not match pin ${pins[rel]} — bump the version (and re-pin) instead of editing in place`,
      );
    }
  }
  return {
    ...def,
    ref: `${def.id}@${def.version}`,
    promptPath: path.join(root, def.prompt),
    inputSchema: JSON.parse(readFileSync(path.join(root, def.input_schema), "utf8")),
    outputSchema: JSON.parse(readFileSync(path.join(root, def.output_schema), "utf8")),
  };
}

/**
 * @returns {{ root: string, agents: Map<string, object>, eventTypes: object, schemas: object }}
 */
export function loadRegistry({ root = RUNTIME_ROOT } = {}) {
  const agents = new Map();
  const agentsDir = path.join(root, "agents");
  for (const name of readdirSync(agentsDir).filter((n) => n.endsWith(".json")).sort()) {
    const def = loadAgentDef(root, path.join(agentsDir, name));
    if (agents.has(def.ref)) throw new RegistryError(`duplicate agent definition ${def.ref}`);
    agents.set(def.ref, def);
  }

  const eventTypes = JSON.parse(readFileSync(path.join(root, "event-types.json"), "utf8"));
  for (const [type, mapping] of Object.entries(eventTypes)) {
    if (!mapping.agent || !agents.has(mapping.agent)) {
      throw new RegistryError(`event type ${type} maps to unregistered agent ${mapping.agent}`);
    }
    if (!Array.isArray(mapping.idempotencyScope) || mapping.idempotencyScope.length === 0) {
      throw new RegistryError(`event type ${type} declares no idempotency scope (§5.4)`);
    }
  }

  const schemas = {
    envelope: JSON.parse(readFileSync(path.join(root, "schemas", "factory.event.v1.json"), "utf8")),
    agentResult: JSON.parse(readFileSync(path.join(root, "schemas", "factory.agent-result.v1.json"), "utf8")),
  };

  return { root, agents, eventTypes, schemas };
}

export function getAgent(registry, ref) {
  const def = registry.agents.get(ref);
  if (!def) throw new RegistryError(`unregistered agent ${ref}`);
  return def;
}

export function getEventType(registry, type) {
  return registry.eventTypes[type] ?? null;
}

/** Recompute every definition's pins in place — the deliberate operator verb. */
export function updatePins({ root = RUNTIME_ROOT } = {}) {
  const changed = [];
  const agentsDir = path.join(root, "agents");
  for (const name of readdirSync(agentsDir).filter((n) => n.endsWith(".json")).sort()) {
    const file = path.join(agentsDir, name);
    const def = JSON.parse(readFileSync(file, "utf8"));
    const pins = {};
    for (const field of PINNED_FIELDS) {
      if (!def[field]) continue;
      pins[def[field]] = hashBytes(readFileSync(path.join(root, def[field])));
    }
    if (JSON.stringify(def.pins) !== JSON.stringify(pins)) {
      writeFileSync(file, `${JSON.stringify({ ...def, pins }, null, 2)}\n`, "utf8");
      changed.push(name);
    }
  }
  return changed;
}
