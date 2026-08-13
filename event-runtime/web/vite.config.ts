import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The Graph view's two heavyweights get their own chunks (OPS-255). Left in
// the entry chunk they made Overview/Events/Runs pay ~2 MB before painting a
// single row. `elk` is also async — Graph.tsx imports the layout module
// dynamically, so the layout engine is fetched only when a graph is drawn.
//
// Accepted warning: the `elk` chunk is ~1.4 MB and still trips Vite's 500 kB
// notice. elkjs ships as one pre-minified GWT artifact (a single module, no
// tree-shakeable surface), so there is nothing left to split — the only lever
// is dropping the dependency, and hand-rolled DAG layout is worse. We do not
// raise build.chunkSizeWarningLimit to silence it: that would also stop the
// warning from firing on the entry chunk, which is the one worth watching.
const VENDOR_CHUNKS: Array<[chunk: string, packages: string[]]> = [
  ["elk", ["elkjs"]],
  [
    "xyflow",
    [
      "@xyflow/react",
      "@xyflow/system",
      "classcat",
      "zustand",
      "use-sync-external-store",
      "d3-color",
      "d3-dispatch",
      "d3-drag",
      "d3-ease",
      "d3-interpolate",
      "d3-selection",
      "d3-timer",
      "d3-transition",
      "d3-zoom",
    ],
  ],
];

function vendorChunk(id: string): string | undefined {
  const marker = "/node_modules/";
  const at = id.lastIndexOf(marker);
  if (at === -1) return undefined;
  const rest = id.slice(at + marker.length);
  for (const [chunk, packages] of VENDOR_CHUNKS) {
    if (packages.some((pkg) => rest === pkg || rest.startsWith(`${pkg}/`))) return chunk;
  }
  return undefined;
}

// Dev-server proxy mirrors serve.mjs: the browser sees one origin, /api/*
// forwards to the loopback control API (webui spec §3).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    rollupOptions: {
      output: { manualChunks: vendorChunk },
    },
  },
  server: {
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${process.env.FACTORY_EVENT_PORT || 7381}`,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
});
