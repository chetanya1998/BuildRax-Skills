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
      "@buildrax/skills": src("skills"),
      "@buildrax/cost": src("cost"),
      "@buildrax/pricing": src("pricing"),
      "@buildrax/viewer": src("viewer"),
      "@buildrax/design": src("design"),
    },
  },
  test: { include: ["packages/*/test/**/*.test.ts"] },
});
