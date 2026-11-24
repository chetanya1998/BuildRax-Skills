import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "**/coverage/**", "fixtures/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Landing page (GitHub Pages): a plain browser script, not a workspace package.
    files: ["site/**/*.js"],
    languageOptions: {
      sourceType: "script",
      globals: Object.fromEntries(
        [
          "addEventListener",
          "document",
          "getSelection",
          "Image",
          "innerHeight",
          "IntersectionObserver",
          "localStorage",
          "matchMedia",
          "navigator",
          "performance",
          "requestAnimationFrame",
          "scrollY",
          "setTimeout",
        ].map((g) => [g, "readonly"]),
      ),
    },
  },
);
