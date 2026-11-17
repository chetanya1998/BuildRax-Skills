import { promises as fs } from "node:fs";
import path from "node:path";
import { fileCycles, GraphIndex, hubs } from "@buildrax/graph";
import { scan } from "@buildrax/ingest";
import { validateModel, type Model } from "@buildrax/ir";
import { modelPathFor } from "./data.js";

export interface ScanSummary {
  repo: string;
  modelPath: string;
  languages: string[];
  counts: {
    nodes: number;
    edges: number;
    files: number;
    modules: number;
    external: number;
    unresolved: number;
  };
  cycles: string[][];
  hubs: { id: string; fanIn: number; fanOut: number }[];
}

/** Scan, validate and write `.buildrax/model.json`. Returns a summary for printing. */
export async function scanCommand(repoPath: string): Promise<ScanSummary> {
  const root = path.resolve(repoPath);
  const model = await scan(root);
  const checked = validateModel(model);
  if (!checked.ok)
    throw new Error(`generated model failed validation:\n${checked.errors.slice(0, 5).join("\n")}`);

  const dir = path.join(root, ".buildrax");
  await fs.mkdir(dir, { recursive: true });
  const modelPath = modelPathFor(root);
  // Atomic write: temp file then rename.
  await fs.writeFile(`${modelPath}.tmp`, `${JSON.stringify(model, null, 2)}\n`);
  await fs.rename(`${modelPath}.tmp`, modelPath);
  await fs.writeFile(path.join(dir, ".gitignore"), "view.html\n*.tmp\ncache/\n");
  return summarize(model, modelPath);
}

export function summarize(model: Model, modelPath: string): ScanSummary {
  const index = new GraphIndex(model);
  const count = (k: string): number => model.nodes.filter((n) => n.kind === k).length;
  return {
    repo: model.meta.repo,
    modelPath,
    languages: model.meta.languages,
    counts: {
      nodes: model.nodes.length,
      edges: model.edges.length,
      files: count("file"),
      modules: count("module"),
      external: count("external"),
      unresolved: count("unresolved"),
    },
    cycles: fileCycles(index).map((c) => c.map((id) => index.node(id)?.path ?? id)),
    hubs: hubs(index, "file", 5),
  };
}

export function formatSummary(s: ScanSummary): string {
  const c = s.counts;
  const lines = [
    `Scanned ${s.repo}  (${s.languages.join(", ") || "no supported languages"})`,
    `  ${c.files} files · ${c.modules} modules · ${c.external} external · ${c.unresolved} unresolved`,
    `  ${c.nodes} nodes · ${c.edges} edges`,
    s.cycles.length
      ? `  ${s.cycles.length} circular dependenc${s.cycles.length === 1 ? "y" : "ies"}:`
      : "  no circular dependencies",
    ...s.cycles.map((cy) => `    ${cy.join(" <-> ")}`),
    "  most connected files:",
    ...s.hubs.map((h) => `    ${h.id.replace(/^file:/, "")}  (in ${h.fanIn}, out ${h.fanOut})`),
    `Model written to ${s.modelPath}`,
  ];
  return lines.join("\n");
}
