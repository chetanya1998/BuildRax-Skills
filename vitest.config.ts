import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (pkg: string): string =>
  fileURLToPath(new URL(`./packages/${pkg}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    // Tests run against workspace sources so they never see stale builds.
    alias: {
      "@buildrax/ir": src("ir"),
      "@buildrax/ingest": src("ingest"),
      "@buildrax/graph": src("graph"),
      "@buildrax/context": src("context"),
      "@buildrax/research": src("research"),
      "@buildrax/viewer": src("viewer"),
    },
  },
  test: { include: ["packages/*/test/**/*.test.ts"] },
});
