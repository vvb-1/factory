import { tmpDir } from "../test-support/tmp.mjs?file=event-runtime-lib-panel-view-test-mjs";
import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PANEL_ENDPOINTS } from "./api-panels.mjs";
import { RUNTIME_ROOT } from "./config.mjs";
import { loadExtensions } from "./extensions.mjs";
import {
  DEFAULT_REFRESH_SECONDS,
  PANEL_SUFFIX,
  PANEL_VIEW_FORMAT,
  loadPanelDir,
  mergePanels,
  readPanelFile,
  validatePanelView,
} from "./panel-view.mjs";
import { loadRegistry } from "./registry.mjs";

const BUILTIN_PANEL = path.join(
  RUNTIME_ROOT,
  "panels",
  "inbox-open.panel.json",
);
const SAMPLE_EXTENSION = path.join(
  RUNTIME_ROOT,
  "test-support",
  "extensions",
  "sample",
);
const SAMPLE_PACK = path.join(RUNTIME_ROOT, "test-support", "packs", "sample");

/** The decided panel shape from the ticket, over the artifact-view vocabulary. */
function samplePanel(overrides = {}) {
  const doc = {
    format: PANEL_VIEW_FORMAT,
    name: "wattmind/mobile:blocked-tickets",
    title: "Blocked > 24h",
    source: {
      endpoint: "/tickets",
      query: { state: "blocked" },
      path: "/items",
    },
    refreshSeconds: 60,
    view: {
      sections: [
        {
          path: "",
          as: "table",
          columns: ["identifier", "title"],
          formats: { identifier: "issue" },
        },
      ],
    },
    ...overrides,
  };
  // `key: undefined` means "leave the key out" — a schema sees presence.
  for (const key of Object.keys(doc))
    if (doc[key] === undefined) delete doc[key];
  return doc;
}

function writePanel(dir, name, doc) {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}${PANEL_SUFFIX}`);
  writeFileSync(file, typeof doc === "string" ? doc : JSON.stringify(doc));
  return file;
}

describe("validatePanelView (factory.panel-view/v1, WM-840)", () => {
  test("accepts the decided shape, normalises defaults and strips nothing the renderer needs", () => {
    const { panel, anomaly } = validatePanelView(samplePanel());
    expect(anomaly).toBeNull();
    expect(panel).toEqual({
      format: PANEL_VIEW_FORMAT,
      name: "wattmind/mobile:blocked-tickets",
      title: "Blocked > 24h",
      source: {
        endpoint: "/tickets",
        query: { state: "blocked" },
        path: "/items",
      },
      refreshSeconds: 60,
      view: {
        sections: [
          {
            path: "",
            as: "table",
            columns: ["identifier", "title"],
            formats: { identifier: "issue" },
          },
        ],
      },
    });
    // Optional bits default: no query, whole response, 60 s.
    const minimal = validatePanelView(
      samplePanel({
        source: { endpoint: "/status" },
        refreshSeconds: undefined,
        view: { sections: [{ path: "/workers", as: "keyvalue" }] },
      }),
    );
    expect(minimal.anomaly).toBeNull();
    expect(minimal.panel.source).toEqual({
      endpoint: "/status",
      query: {},
      path: "",
    });
    expect(minimal.panel.refreshSeconds).toBe(DEFAULT_REFRESH_SECONDS);
    // A view that spells out the artifact-view schemaVersion is fine; it is
    // implied by the format and not served back.
    const explicit = validatePanelView(
      samplePanel({
        view: {
          schemaVersion: "factory.artifact-view/v1",
          sections: [{ path: "", as: "badge" }],
        },
      }),
    );
    expect(explicit.anomaly).toBeNull();
    expect(explicit.panel.view).toEqual({
      sections: [{ path: "", as: "badge" }],
    });
  });

  test("rejects schema violations: format, name, missing keys, bad refresh, unknown keys", () => {
    const cases = [
      [samplePanel({ format: "factory.panel-view/v2" }), /panel\.format/],
      [samplePanel({ name: "Bad Name" }), /panel\.name/],
      [
        samplePanel({ title: undefined }),
        /panel: missing required property "title"/,
      ],
      [
        samplePanel({ source: undefined }),
        /panel: missing required property "source"/,
      ],
      [
        samplePanel({ view: undefined }),
        /panel: missing required property "view"/,
      ],
      [samplePanel({ refreshSeconds: 1 }), /panel\.refreshSeconds/],
      [samplePanel({ refreshSeconds: 2.5 }), /panel\.refreshSeconds/],
      [samplePanel({ extra: true }), /panel: unknown property "extra"/],
      [
        samplePanel({ source: { endpoint: "/tickets", query: { limit: 5 } } }),
        /panel\.source\.query\.limit/,
      ],
      [
        samplePanel({ source: { endpoint: "/tickets", path: "items" } }),
        /panel\.source\.path/,
      ],
      ["not an object", /panel: expected type object/],
    ];
    for (const [doc, pattern] of cases) {
      const { panel, anomaly } = validatePanelView(doc);
      expect(panel).toBeNull();
      expect(anomaly).toMatch(pattern);
    }
  });

  test("refuses an endpoint that is not an allow-listed GET route — no arbitrary URLs", () => {
    for (const endpoint of [
      "/panels",
      "/runs/abc",
      "/inbox?status=open",
      "/tickets/",
      "/nope",
      "http://evil.example/x",
      "/events/archive",
    ]) {
      const { panel, anomaly } = validatePanelView(
        samplePanel({ source: { endpoint } }),
      );
      expect(panel).toBeNull();
      expect(anomaly).toMatch(/panel\.source\.endpoint/);
    }
    // Every allow-listed route is accepted as written.
    for (const endpoint of PANEL_ENDPOINTS) {
      expect(
        validatePanelView(samplePanel({ source: { endpoint } })).anomaly,
      ).toBeNull();
    }
    // A caller-supplied allow-list is honoured (narrower or wider).
    expect(
      validatePanelView(samplePanel(), { endpoints: ["/status"] }).anomaly,
    ).toMatch(
      /"\/tickets" is not an allow-listed GET route \(allowed: \/status\)/,
    );
    expect(
      validatePanelView(samplePanel({ source: { endpoint: "/custom" } }), {
        endpoints: ["/custom"],
      }).anomaly,
    ).toBeNull();
  });

  test("validates `view` with the artifact-view vocabulary — the existing validator, not a copy", () => {
    const bad = [
      [
        { sections: [{ path: "", as: "chart" }] },
        /panel\.view\.sections\[0\]\.as: .*not in enum/,
      ],
      [
        { sections: [{ path: "", as: "table" }] },
        /as=table requires "columns"/,
      ],
      [
        { sections: [{ path: "", as: "badge", columns: ["x"] }] },
        /"columns" is not a key of as=badge/,
      ],
      [
        { sections: [{ path: "", as: "badge", tone: { open: "loud" } }] },
        /badge tone must be one of/,
      ],
      [
        { sections: [{ path: "", as: "list", formats: { "": "emoji" } }] },
        /panel\.view\.sections\[0\]\.formats\./,
      ],
      [{ sections: [] }, /panel\.view\.sections: fewer than minItems 1/],
      [
        { sections: [{ path: "items", as: "list" }] },
        /panel\.view\.sections\[0\]\.path/,
      ],
      [
        {
          schemaVersion: "factory.artifact-view/v0",
          sections: [{ path: "", as: "prose" }],
        },
        /panel\.view\.schemaVersion/,
      ],
      [
        { sections: [{ path: "", as: "prose" }], nested: true },
        /panel\.view: unknown property "nested"/,
      ],
    ];
    for (const [view, pattern] of bad) {
      const { panel, anomaly } = validatePanelView(samplePanel({ view }));
      expect(panel).toBeNull();
      expect(anomaly).toMatch(pattern);
    }
    // Endpoint and view errors are both reported, not first-wins.
    const both = validatePanelView(
      samplePanel({
        source: { endpoint: "/nope" },
        view: { sections: [{ path: "", as: "chart" }] },
      }),
    );
    expect(both.anomaly).toMatch(/not an allow-listed GET route/);
    expect(both.anomaly).toMatch(/not in enum/);
  });

  test("the built-in panel is valid and reads back what its file says", () => {
    const doc = JSON.parse(readFileSync(BUILTIN_PANEL, "utf8"));
    const { panel, anomaly } = readPanelFile(BUILTIN_PANEL);
    expect(anomaly).toBeNull();
    expect(panel.name).toBe("inbox-open");
    expect(panel.source).toEqual({
      endpoint: "/inbox",
      query: { status: "open" },
      path: "/items",
    });
    expect(panel.refreshSeconds).toBe(doc.refreshSeconds);
    expect(panel.view.sections[0].as).toBe("table");
  });
});

describe("loadPanelDir / mergePanels", () => {
  test("loads every *.panel.json in name order, skips bad ones with an anomaly, ignores other files", () => {
    const root = tmpDir("evrt-panels-");
    const dir = path.join(root, "panels");
    writePanel(dir, "b-second", samplePanel({ name: "b-second" }));
    writePanel(dir, "a-first", samplePanel({ name: "a-first" }));
    writePanel(dir, "broken", "{ not json");
    writePanel(
      dir,
      "wrong-endpoint",
      samplePanel({ name: "wrong-endpoint", source: { endpoint: "/nope" } }),
    );
    mkdirSync(path.join(dir, "not-a-panel.panel.json"));
    writeFileSync(path.join(dir, "README.json"), JSON.stringify(samplePanel()));

    const { panels, anomalies } = loadPanelDir(dir, { origin: "pack:x" });
    expect(panels.map((p) => p.name)).toEqual(["a-first", "b-second"]);
    expect(panels[0]).toMatchObject({
      origin: "pack:x",
      file: "panels/a-first.panel.json",
      refreshSeconds: 60,
    });
    expect(anomalies).toHaveLength(3);
    expect(anomalies[0]).toMatch(
      /broken\.panel\.json is unparseable.*\[pack:x\]/,
    );
    expect(anomalies[1]).toMatch(/not-a-panel\.panel\.json is unparseable/);
    expect(anomalies[2]).toMatch(
      /wrong-endpoint\.panel\.json is invalid \(skipped\): panel\.source\.endpoint: "\/nope" is not an allow-listed GET route/,
    );
    // `base` controls what the served file is relative to.
    expect(
      loadPanelDir(dir, { origin: "extension:e", base: root }).panels[0].file,
    ).toBe("panels/a-first.panel.json");
    // A missing directory is no panels, not an error.
    expect(
      loadPanelDir(path.join(root, "absent"), { origin: "pack:x" }),
    ).toEqual({
      panels: [],
      anomalies: [],
    });
  });

  test("merges contributors first-wins on name and reports the loser", () => {
    const a = { name: "dup", origin: "builtin", file: "panels/dup.panel.json" };
    const b = { name: "dup", origin: "pack:p", file: "panels/dup.panel.json" };
    const c = {
      name: "other",
      origin: "pack:p",
      file: "panels/other.panel.json",
    };
    const merged = mergePanels([
      { panels: [a], anomalies: ["earlier"] },
      { panels: [b, c], anomalies: [] },
    ]);
    expect(merged.panels).toEqual([a, c]);
    expect(merged.anomalies).toEqual([
      "earlier",
      'panel panels/dup.panel.json [pack:p] duplicates panel name "dup" already contributed by panels/dup.panel.json [builtin] (skipped)',
    ]);
  });
});

describe("registry + extension panel loading (WM-840)", () => {
  test("the committed registry ships the built-in panel and no anomalies", () => {
    const registry = loadRegistry();
    expect(registry.panels.map((p) => [p.name, p.origin, p.file])).toEqual([
      ["inbox-open", "builtin", "panels/inbox-open.panel.json"],
    ]);
    expect(registry.anomalies).toEqual([]);
  });

  test("packs contribute panels/*.panel.json as pack:<namespace>; extensions via contributes.panels as extension:<name>", async () => {
    // A configured pack: copy the sample pack and give it a panels/ dir.
    const packDir = tmpDir("evrt-panel-pack-");
    const { cpSync } = await import("node:fs");
    cpSync(SAMPLE_PACK, packDir, { recursive: true });
    writePanel(
      path.join(packDir, "panels"),
      "spend",
      samplePanel({ name: "sample:spend", source: { endpoint: "/metrics" } }),
    );
    writePanel(
      path.join(packDir, "panels"),
      "shadow",
      samplePanel({ name: "inbox-open" }),
    );
    writePanel(
      path.join(packDir, "panels"),
      "bad",
      samplePanel({ name: "sample:bad", view: { sections: [] } }),
    );
    const packManifest = JSON.parse(
      readFileSync(path.join(packDir, "pack.json"), "utf8"),
    );

    // The fixture extension contributes ./panels.
    const extensions = await loadExtensions({
      policy: { extensions: [{ path: SAMPLE_EXTENSION }] },
      packRoots: [{ kind: "fs", name: packManifest.name, path: packDir }],
    });
    expect(extensions.anomalies).toEqual([]);

    const registry = loadRegistry({
      packRoots: extensions.packRoots,
      panelRoots: extensions.panelRoots,
    });
    expect(registry.panels.map((p) => [p.name, p.origin, p.file])).toEqual([
      ["inbox-open", "builtin", "panels/inbox-open.panel.json"],
      [
        "sample:spend",
        `pack:${packManifest.namespace}`,
        "panels/spend.panel.json",
      ],
      [
        "factory/sample:open-proposals",
        "extension:factory/sample",
        "panels/open-proposals.panel.json",
      ],
    ]);
    // Bad and shadowing panels are configuration anomalies, everything else loads.
    expect(registry.anomalies).toHaveLength(2);
    expect(registry.anomalies[0]).toMatch(
      /bad\.panel\.json is invalid \(skipped\).*sections: fewer than minItems 1/,
    );
    expect(registry.anomalies[1]).toMatch(
      /shadow\.panel\.json \[pack:sample\] duplicates panel name "inbox-open" already contributed by panels\/inbox-open\.panel\.json \[builtin\]/,
    );
    // Malformed panelRoots fail closed like every other loader input.
    expect(() => loadRegistry({ panelRoots: "nope" })).toThrow(
      /panelRoots must be an array/,
    );
    expect(() => loadRegistry({ panelRoots: [{ dir: 1 }] })).toThrow(
      /panelRoots entries/,
    );
  });
});
