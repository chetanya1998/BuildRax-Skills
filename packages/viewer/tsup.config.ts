import { defineConfig } from "tsup";

// Node-side helpers only. The browser app is built by Vite into dist/viewer.html (runs first).
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  clean: false,
  target: "node22",
});
