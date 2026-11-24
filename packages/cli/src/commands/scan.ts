import { promises as fs } from "node:fs";
import path from "node:path";
import { fileCycles, GraphIndex, hubs } from "@buildrax/graph";
import { scan, type ScanStats } from "@buildrax/ingest";
import { validateModel, type Model } from "@buildrax/ir";
import { modelPathFor } from "./data.js";
import { previousModelPathFor, scanCachePathFor } from "./diff.js";

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
    routes: number;
  };
  cycles: string[][];
  hubs: { id: string; fanIn: number; fanOut: number }[];
  /** How much parsing the scan did (unchanged files are reused from the cache). */
  work?: ScanStats;
}

/** Scan, validate and write `.buildrax/model.json`. Returns a summary for printing. */
export async function scanCommand(
  repoPath: string,
  opts: { cache?: boolean } = {},
): Promise<ScanSummary> {
  const root = path.resolve(repoPath);
  const stats: ScanStats = { files: 0, parsed: 0, reused: 0, ms: 0 };
  const model = await scan(root, {
    cacheFile: opts.cache === false ? undefined : scanCachePathFor(root),
    stats,
  });
  const checked = validateModel(model);
  if (!checked.ok)
    throw new Error(`generated model failed validation:\n${checked.errors.slice(0, 5).join("\n")}`);

  const dir = path.join(root, ".buildrax");
  await fs.mkdir(dir, { recursive: true });
  const modelPath = modelPathFor(root);
  // Keep the previous model so `buildrax diff` can show what this scan changed.
  try {
    await fs.mkdir(path.dirname(previousModelPathFor(root)), { recursive: true });
    await fs.copyFile(modelPath, previousModelPathFor(root));
  } catch {
    // first scan: nothing to keep
  }
  // Atomic write: temp file then rename.
  await fs.writeFile(`${modelPath}.tmp`, `${JSON.stringify(model, null, 2)}\n`);
  await fs.rename(`${modelPath}.tmp`, modelPath);
  await fs.writeFile(path.join(dir, ".gitignore"), "view.html\n*.tmp\ncache/\ncost-prices.json\n");
  return { ...summarize(model, modelPath), work: stats };
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
      routes: count("route"),
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
    `  ${c.nodes} nodes · ${c.edges} edges${c.routes ? ` · ${c.routes} endpoint(s) (buildrax routes)` : ""}`,
    s.cycles.length
      ? `  ${s.cycles.length} circular dependenc${s.cycles.length === 1 ? "y" : "ies"}:`
      : "  no circular dependencies",
    ...s.cycles.map((cy) => `    ${cy.join(" <-> ")}`),
    "  most connected files:",
    ...s.hubs.map((h) => `    ${h.id.replace(/^file:/, "")}  (in ${h.fanIn}, out ${h.fanOut})`),
    ...(s.work
      ? [
          `  parsed ${s.work.parsed} file(s), reused ${s.work.reused} unchanged, in ${(s.work.ms / 1000).toFixed(1)} s`,
        ]
      : []),
    `Model written to ${s.modelPath}`,
  ];
  return lines.join("\n");
}
