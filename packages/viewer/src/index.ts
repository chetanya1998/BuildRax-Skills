import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Model, NotesFile, ResearchFile } from "@buildrax/ir";

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

/** JSON that is safe inside a <script> element: `<` and line separators are escaped. */
function safeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/[\u2028\u2029]/g, " ");
}

function setScript(html: string, id: string, value: unknown): string {
  const tag = new RegExp(`(<script id="${id}" type="application/json">)([\\s\\S]*?)(</script>)`);
  if (!tag.test(html)) throw new Error(`viewer template has no ${id} script tag`);
  return html.replace(
    tag,
    (_m, open: string, _old: string, close: string) => `${open}${safeJson(value)}${close}`,
  );
}

export interface InjectExtras {
  notes?: NotesFile;
  research?: ResearchFile;
  /** Present when served by `buildrax serve`; tells the page to use the notes API. */
  config?: { server: true; token: string; version?: number; watch?: boolean };
  /** Source text by repo-relative path, for the Code tab in static files. */
  sources?: Record<string, string>;
  /** Redacted config-file excerpts around evidence lines, keyed `file:line`. */
  excerpts?: Record<string, { start: number; lines: string[] }>;
  /** Cost report plus the prices it may need, for the Cost view (`buildrax cost`). */
  cost?: { report: unknown; prices: unknown };
}

/** Embed a model (and optional notes/research/config) into the viewer HTML. */
export function injectModel(html: string, model: Model, extras: InjectExtras = {}): string {
  let out = setScript(html, "buildrax-data", model);
  if (extras.notes) out = setScript(out, "buildrax-notes", extras.notes);
  if (extras.research) out = setScript(out, "buildrax-research", extras.research);
  if (extras.config) out = setScript(out, "buildrax-config", extras.config);
  if (extras.sources) out = setScript(out, "buildrax-sources", extras.sources);
  if (extras.cost) out = setScript(out, "buildrax-cost", extras.cost);
  if (extras.excerpts) out = setScript(out, "buildrax-excerpts", extras.excerpts);
  return out;
}
