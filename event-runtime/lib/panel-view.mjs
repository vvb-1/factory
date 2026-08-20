/**
 * Panels — `factory.panel-view/v1` (WM-840, docs/event-runtime-artifact-views.md §2.6).
 *
 * A panel is the artifact-view idea generalised past one agent's artifact:
 * a declarative tile that names an existing loopback GET endpoint, selects a
 * node of its response with an RFC 6901 pointer, and describes how to draw
 * that node with the same closed hint vocabulary the artifact-view renderer
 * already speaks (`table|keyvalue|list|badge|code|prose`). Packs contribute
 * them as `panels/*.panel.json`, extensions through `contributes.panels`,
 * and one ships built in; the web draws them on Overview with
 * `components/ArtifactView.tsx`, so a pack gets a dashboard tile without
 * shipping React.
 *
 * Three checks, all fail closed, all here rather than in the renderer:
 *   1. the document matches schemas/panel-view.schema.json (lib/schema.mjs);
 *   2. `source.endpoint` is on the allow-list in lib/api-panels.mjs — the
 *      web will fetch whatever a panel names, so this is what keeps a
 *      third-party panel from pointing the browser at an arbitrary route;
 *   3. `view` is a valid artifact-view body (`validateArtifactViewShape`),
 *      minus the pointer-drift check, because an endpoint has no schema.
 * A panel that fails is a configuration anomaly (`/status.anomalies.configuration`)
 * and is skipped; the rest of its contributor still loads.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { PANEL_ENDPOINTS } from "./api-panels.mjs";
import {
  ARTIFACT_VIEW_SCHEMA_VERSION,
  validateArtifactViewShape,
} from "./artifact-view.mjs";
import { RUNTIME_ROOT } from "./config.mjs";
import { validate } from "./schema.mjs";

export const PANEL_VIEW_FORMAT = "factory.panel-view/v1";
export const PANEL_VIEW_SCHEMA = JSON.parse(
  readFileSync(
    path.join(RUNTIME_ROOT, "schemas", "panel-view.schema.json"),
    "utf8",
  ),
);
/** Where a pack (or the built-in root) keeps its panels, and how a panel file is named. */
export const PANELS_DIR = "panels";
export const PANEL_SUFFIX = ".panel.json";
export const DEFAULT_REFRESH_SECONDS = 60;

const isObject = (v) =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Validate one panel document. Never throws.
 * @param {unknown} doc - the parsed panel
 * @param {{ endpoints?: readonly string[] }} [options] - the endpoint allow-list (default: PANEL_ENDPOINTS)
 * @returns {{ panel: object|null, anomaly: string|null }} `panel` is the
 *   normalised document (`source.query` and `source.path` present,
 *   `refreshSeconds` defaulted) or null with `anomaly` naming every error.
 */
export function validatePanelView(doc, { endpoints = PANEL_ENDPOINTS } = {}) {
  const schemaCheck = validate(PANEL_VIEW_SCHEMA, doc, "panel");
  if (!schemaCheck.valid) {
    return { panel: null, anomaly: schemaCheck.errors.join("; ") };
  }
  const errors = [];
  const endpoint = doc.source.endpoint;
  if (!endpoints.includes(endpoint)) {
    errors.push(
      `panel.source.endpoint: "${endpoint}" is not an allow-listed GET route (allowed: ${endpoints.join(", ")})`,
    );
  }
  // `view` is an artifact-view body; the format implies the schemaVersion,
  // but a document that spells one out must spell the right one.
  const viewDoc = Object.hasOwn(doc.view, "schemaVersion")
    ? doc.view
    : { schemaVersion: ARTIFACT_VIEW_SCHEMA_VERSION, ...doc.view };
  const viewCheck = validateArtifactViewShape(viewDoc);
  if (!viewCheck.valid) {
    errors.push(...viewCheck.errors.map((e) => `panel.${e}`));
  }
  if (errors.length > 0) return { panel: null, anomaly: errors.join("; ") };
  const { schemaVersion: _ignored, ...view } = viewDoc;
  return {
    panel: {
      format: doc.format,
      name: doc.name,
      title: doc.title,
      ...(doc.description !== undefined
        ? { description: doc.description }
        : {}),
      source: {
        endpoint,
        query: isObject(doc.source.query) ? { ...doc.source.query } : {},
        path: typeof doc.source.path === "string" ? doc.source.path : "",
      },
      refreshSeconds: doc.refreshSeconds ?? DEFAULT_REFRESH_SECONDS,
      view,
    },
    anomaly: null,
  };
}

/**
 * Read and validate one `*.panel.json`. Unparseable JSON is the same class
 * of anomaly as an invalid document.
 * @returns {{ panel: object|null, anomaly: string|null }}
 */
export function readPanelFile(file, options) {
  let doc;
  try {
    doc = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    return {
      panel: null,
      anomaly: `panel ${file} is unparseable: ${err.message}`,
    };
  }
  const { panel, anomaly } = validatePanelView(doc, options);
  if (anomaly)
    return {
      panel: null,
      anomaly: `panel ${file} is invalid (skipped): ${anomaly}`,
    };
  return { panel, anomaly: null };
}

/**
 * Load every `*.panel.json` directly under `dir` (sorted, not recursive),
 * tagging each accepted panel with the contributor it came from and the file
 * it was read from. A missing directory is simply no panels; a file that
 * fails is an anomaly and the others still load. Name uniqueness across
 * contributors is the registry's job (lib/registry.mjs), not this loader's.
 *
 * @param {string} dir
 * @param {{ origin: string, base?: string, endpoints?: readonly string[] }} options -
 *   `origin` is `builtin`, `pack:<namespace>` or `extension:<name>`; `base`
 *   is the contributor root the served `file` is made relative to (default:
 *   the panel directory's parent — anomalies always name the absolute path)
 * @returns {{ panels: Array<object>, anomalies: string[] }}
 */
export function loadPanelDir(dir, { origin, base, endpoints } = {}) {
  const panels = [];
  const anomalies = [];
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    return { panels, anomalies };
  }
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(PANEL_SUFFIX)) continue;
    const file = path.join(dir, name);
    const { panel, anomaly } = readPanelFile(file, { endpoints });
    if (anomaly) {
      anomalies.push(`${anomaly}${origin ? ` [${origin}]` : ""}`);
      continue;
    }
    panels.push({
      ...panel,
      origin: origin ?? "builtin",
      file: path.relative(base ?? path.dirname(dir), file),
    });
  }
  return { panels, anomalies };
}

/**
 * Merge panels from several contributors into one list with unique names —
 * first contributor wins, in load order (built-in, then packs in policy
 * order, then extensions in policy order), and the loser is an anomaly, not
 * a silent override: a pack may not shadow a built-in tile any more than it
 * may shadow a built-in agent.
 * @param {Array<{ panels: object[], anomalies: string[] }>} batches
 * @returns {{ panels: object[], anomalies: string[] }}
 */
export function mergePanels(batches) {
  const panels = [];
  const anomalies = [];
  const byName = new Map();
  for (const batch of batches) {
    anomalies.push(...(batch.anomalies ?? []));
    for (const panel of batch.panels ?? []) {
      const seen = byName.get(panel.name);
      if (seen) {
        anomalies.push(
          `panel ${panel.file} [${panel.origin}] duplicates panel name "${panel.name}" already contributed by ${seen.file} [${seen.origin}] (skipped)`,
        );
        continue;
      }
      byName.set(panel.name, panel);
      panels.push(panel);
    }
  }
  return { panels, anomalies };
}
