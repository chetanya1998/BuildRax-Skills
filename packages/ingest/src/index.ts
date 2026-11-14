import { promises as fs } from "node:fs";
import path from "node:path";
import type { Model } from "@buildrax/ir";
import { buildModel, type SourceFile } from "./build.js";
import { langForFile } from "./languages.js";
import { detectPackages } from "./packages.js";
import { extractImports } from "./parser.js";
import { walkRepo } from "./walk.js";

export { buildModel } from "./build.js";
export type { BuildInput, SourceFile } from "./build.js";
export { extractImports } from "./parser.js";
export type { RawImport } from "./parser.js";
export { walkRepo } from "./walk.js";
export * from "./resolve.js";

export const VERSION = "0.0.0";
const MAX_FILE_BYTES = 1_000_000;

export interface ScanOptions {
  /** Override the timestamp (useful for deterministic tests). */
  now?: string;
}

/** Scan a repository statically and return its Architecture IR. Never executes repo code. */
export async function scan(repoPath: string, options: ScanOptions = {}): Promise<Model> {
  const root = path.resolve(repoPath);
  const allFiles = await walkRepo(root);
  const packages = await detectPackages(root, allFiles);

  const sources: SourceFile[] = [];
  for (const rel of allFiles) {
    const lang = langForFile(rel);
    if (!lang) continue;
    const abs = path.join(root, rel);
    const stat = await fs.stat(abs);
    if (stat.size > MAX_FILE_BYTES) continue;
    const text = await fs.readFile(abs, "utf8");
    sources.push({
      path: rel,
      lang,
      lines: text.split("\n").length,
      imports: await extractImports(text, lang),
    });
  }

  return buildModel({
    repoName: path.basename(root),
    scannedAt: options.now ?? new Date().toISOString(),
    version: VERSION,
    allFiles,
    sources,
    packages,
  });
}
