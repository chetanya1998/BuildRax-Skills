import { promises as fs } from "node:fs";
import path from "node:path";
import type { Model } from "@buildrax/ir";
import { buildModel, type SourceFile } from "./build.js";
import { langForFile } from "./languages.js";
import { detectPackages } from "./packages.js";
import { extractImports } from "./parser.js";
import { walkRepo } from "./walk.js";
import { ParseCache, hashText } from "./cache.js";

export { buildModel } from "./build.js";
export type { BuildInput, SourceFile } from "./build.js";
export { extractImports } from "./parser.js";
export type { RawImport } from "./parser.js";
export { walkRepo } from "./walk.js";
export { ParseCache, hashText } from "./cache.js";
export type { ParseEntry } from "./cache.js";
export * from "./resolve.js";
export {
  detectInfra,
  withInfra,
  scanTerraform,
  dockerfileRuntime,
  prismaProvider,
  parseCpu,
  parseMemoryMb,
  imageRepo,
  serviceForImage,
  SDK_SERVICES,
} from "./infra/index.js";
export type { InfraKind, InfraFacts, ServiceDef } from "./infra/index.js";
import { detectInfra, withInfra } from "./infra/index.js";

export const VERSION = "0.0.0";
const MAX_FILE_BYTES = 1_000_000;

export interface ScanOptions {
  /** Override the timestamp (useful for deterministic tests). */
  now?: string;
  /**
   * Parse cache file for incremental scans (e.g. `.buildrax/cache/scan/files.json`). Unchanged
   * files are not re-parsed; the resulting model is identical to a full scan.
   */
  cacheFile?: string;
  /** Project name (defaults to the folder name). Keeps IDs stable when scanning a copy. */
  repoName?: string;
  /** Filled in with how much work the scan did. */
  stats?: ScanStats;
}

export interface ScanStats {
  files: number;
  parsed: number;
  reused: number;
  ms: number;
}

/** Changes whenever parsing could produce different output: scanner version and grammars. */
export const PARSER_FINGERPRINT = `ingest@${VERSION};tree-sitter-wasms@0.1.13;web-tree-sitter@0.25.10`;

/** Scan a repository statically and return its Architecture IR. Never executes repo code. */
export async function scan(repoPath: string, options: ScanOptions = {}): Promise<Model> {
  const started = Date.now();
  const root = path.resolve(repoPath);
  const cache = await ParseCache.open(options.cacheFile, PARSER_FINGERPRINT);
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
    const hash = hashText(text);
    const hit = cache.get(rel, hash, lang);
    if (hit) {
      sources.push({ path: rel, lang, lines: hit.lines, imports: hit.imports });
      continue;
    }
    const entry = {
      hash,
      lang,
      lines: text.split("\n").length,
      imports: await extractImports(text, lang),
    };
    cache.put(rel, entry);
    sources.push({ path: rel, lang, lines: entry.lines, imports: entry.imports });
  }
  await cache.save();

  const model = buildModel({
    repoName: options.repoName ?? path.basename(root),
    scannedAt: options.now ?? new Date().toISOString(),
    version: VERSION,
    allFiles,
    sources,
    packages,
  });
  // Infrastructure (v2): what the project runs on and pays for.
  const result = withInfra(model, await detectInfra(root, allFiles, model));
  if (options.stats)
    Object.assign(options.stats, {
      files: sources.length,
      parsed: cache.misses,
      reused: cache.hits,
      ms: Date.now() - started,
    });
  return result;
}
