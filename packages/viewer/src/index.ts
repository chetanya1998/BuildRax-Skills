import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Model } from "@buildrax/ir";

/** Absolute path to the built single-file viewer template (placeholder data script inside). */
export function viewerTemplatePath(): string {
  // Built layout: dist/index.js next to dist/viewer.html. Source layout (tests): ../dist/viewer.html.
  const candidates = ["./viewer.html", "../dist/viewer.html"].map((p) =>
    fileURLToPath(new URL(p, import.meta.url)),
  );
  const found = candidates.find((c) => existsSync(c));
  if (!found)
    throw new Error("viewer template not found; run `pnpm --filter @buildrax/viewer build`");
  return found;
}

const DATA_TAG = /(<script id="buildrax-data" type="application\/json">)([\s\S]*?)(<\/script>)/;

/** Embed a model into the viewer HTML. `<` is escaped so the JSON can never close the tag. */
export function injectModel(html: string, model: Model): string {
  const json = JSON.stringify(model)
    .replace(/</g, "\\u003c")
    .replace(/[\u2028\u2029]/g, " ");
  if (!DATA_TAG.test(html)) throw new Error("viewer template has no buildrax-data script tag");
  return html.replace(
    DATA_TAG,
    (_m, open: string, _old: string, close: string) => `${open}${json}${close}`,
  );
}
