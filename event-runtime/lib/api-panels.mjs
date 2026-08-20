/**
 * Panels endpoint (WM-840, docs/event-runtime-artifact-views.md §2.6).
 *
 * `GET /panels` lists the declarative `factory.panel-view/v1` panels the
 * registry accepted at load — built-in, from packs, from extensions — so the
 * web can draw a dashboard tile per panel with the artifact-view renderer
 * and no client-side code loading. Panel *data* is not proxied here: the web
 * fetches each panel's `source.endpoint` itself, and that endpoint must be on
 * the allow-list below, which is why the list lives in this module (the
 * one place that knows which loopback routes a panel may bind to).
 */

/**
 * The GET routes a panel's `source.endpoint` may name. Every entry is a real
 * collection route of the loopback API — the file that answers it is noted
 * — and `api-panels.test.mjs` proves each one answers something other than
 * 404 through `createApi`, so an entry cannot outlive its route. Detail
 * routes (`/runs/<id>`, `/inbox/<id>`, `/chain/<id>`) are deliberately
 * absent: a panel is a standing tile, not a bookmark, and it takes its
 * parameters through `source.query`. `/panels` itself is not listed.
 */
export const PANEL_ENDPOINTS = Object.freeze([
  "/agents", // api-registry.mjs
  "/artifacts", // api-artifacts.mjs
  "/chains", // api-chain.mjs
  "/config", // api-config.mjs
  "/events", // api-runs.mjs
  "/health", // api-intake.mjs
  "/inbox", // api-inbox.mjs
  "/journal", // api-runs.mjs
  "/metrics", // api-metrics.mjs
  "/metrics/breakdown", // api-metrics.mjs
  "/outbox", // api-runs.mjs
  "/proposals", // api-runs.mjs
  "/repos", // api-registry.mjs
  "/runs", // api-runs.mjs
  "/schedules", // api-schedules.mjs
  "/status", // status-view.mjs
  "/tickets", // api-runs.mjs
  "/workers", // status-view.mjs
]);

/**
 * The `/panels` body: every accepted panel with the contributor it came from
 * (`origin`: `builtin`, `pack:<namespace>` or `extension:<name>`) and the
 * file it was read from, plus the endpoint allow-list so a client can refuse
 * to fetch anything else without a second round trip. Invalid panels never
 * reach the registry's list — they are `/status.anomalies.configuration`.
 */
export function panelsView(registry) {
  return {
    panels: (registry?.panels ?? []).map((entry) => ({
      name: entry.name,
      title: entry.title,
      description: entry.description ?? null,
      source: entry.source,
      refreshSeconds: entry.refreshSeconds,
      view: entry.view,
      origin: entry.origin,
      file: entry.file,
    })),
    endpoints: [...PANEL_ENDPOINTS],
  };
}

export function handlePanelsApiRoute({ route, send, registry }) {
  if (route === "GET /panels") return send(200, panelsView(registry));
  return false;
}
