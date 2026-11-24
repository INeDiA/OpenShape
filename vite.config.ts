/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const isolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

export default defineConfig({
  plugins: [react()],
  worker: { format: "es" },
  // The OCCT WASM bundle must not be pre-bundled by esbuild.
  optimizeDeps: { exclude: ["replicad-opencascadejs"] },
  // Cross-origin isolation lets the kernel use the multi-threaded OCCT build
  // (SharedArrayBuffer); the app loads nothing from other origins. Static hosts
  // that can't send these headers (GitHub Pages) get them from public/coi-sw.js.
  server: { port: 5176, headers: isolation },
  preview: { headers: isolation },
  // Kernel tests run real OpenCascade: several seconds each when the suite runs in parallel.
  test: { testTimeout: 30_000 },
});
