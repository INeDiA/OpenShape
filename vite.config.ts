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
  // (SharedArrayBuffer); the app loads nothing from other origins.
  server: { port: 5176, headers: isolation },
  preview: { headers: isolation },
});
