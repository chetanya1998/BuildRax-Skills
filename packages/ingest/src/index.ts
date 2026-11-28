import { promises as fs } from "node:fs";
import path from "node:path";
import type { FunctionsFile, Model } from "@buildrax/ir";
import { buildFunctionIndex } from "./functions/build.js";
import { buildModelWithContext, type SourceFile } from "./build.js";
import { emptyFacts } from "./routes/facts.js";
import { linkDataOps, withDataOps } from "./dataops/link.js";
import { prismaEntities } from "./entities/facts.js";
import { buildEntities, withEntities } from "./entities/build.js";
import { langForFile } from "./languages.js";
import { detectPackages } from "./packages.js";
import { parseFile } from "./parser.js";
import { readAliasConfigs } from "./tsconfig.js";
import { walkRepo } from "./walk.js";
import { ParseCache, hashText } from "./cache.js";
import { readLockedVersions, readRuntimes, withVersions } from "./versions.js";

export { buildModel, buildModelWithContext } from "./build.js";
export { classifySql, jsDataFacts, pyDataFacts } from "./dataops/facts.js";
export type { RawOp, RawClient, OpKind, OpSystem } from "./dataops/facts.js";
export { linkDataOps, withDataOps } from "./dataops/link.js";
export { jsEntities, pyEntities, prismaEntities } from "./entities/facts.js";
export type { RawEntity, RawField, RawRelation } from "./entities/facts.js";
export { buildEntities, withEntities, entitiesForTable, entityKey } from "./entities/build.js";
export type { BuildInput, SourceFile } from "./build.js";
export { jsFunctions, pyFunctions } from "./functions/facts.js";
export type { RawFn, RawCall } from "./functions/facts.js";
export { buildFunctionIndex } from "./functions/build.js";
export { extractImports, parseFile } from "./parser.js";
export type { RawImport, FileParse } from "./parser.js";
export { jsFacts, pyFacts, joinPath, literal } from "./routes/facts.js";
export type { FileFacts, RawRoute, RawMount } from "./routes/facts.js";
export { buildRoutes, nextRoutePath } from "./routes/build.js";
export type { RouteMeta } from "./routes/build.js";
export { parseJsonc, readAliasConfigs, aliasCandidates } from "./tsconfig.js";
export type { AliasConfig } from "./tsconfig.js";
export { walkRepo, isWatchedPath, ALWAYS_IGNORED } from "./walk.js";
export { ParseCache, hashText } from "./cache.js";
export {
  readLockedVersions,
  readRuntimes,
  withVersions,
  minimumVersion,
  normalizePy,
} from "./versions.js";
export type { Locked, RuntimeDecl } from "./versions.js";
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
export const PARSER_FINGERPRINT = `ingest@${VERSION};facts@6;tree-sitter-wasms@0.1.13;web-tree-sitter@0.25.10`;

/** Scan a repository statically and return its Architecture IR. Never executes repo code. */
export async function scan(repoPath: string, options: ScanOptions = {}): Promise<Model> {
  return (await scanDetailed(repoPath, options)).model;
}

/** The model plus the function index side file (`.buildrax/functions.json`). */
export async function scanDetailed(
  repoPath: string,
  options: ScanOptions = {},
): Promise<{ model: Model; functions: FunctionsFile }> {
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
      sources.push({ path: rel, lang, lines: hit.lines, imports: hit.imports, facts: hit.facts });
      continue;
    }
    const entry = { hash, lang, lines: text.split("\n").length, ...(await parseFile(text, lang)) };
    cache.put(rel, entry);
    sources.push({
      path: rel,
      lang,
      lines: entry.lines,
      imports: entry.imports,
      facts: entry.facts,
    });
  }
  await cache.save();

  const { model, ...ctx } = buildModelWithContext({
    repoName: options.repoName ?? path.basename(root),
    scannedAt: options.now ?? new Date().toISOString(),
    version: VERSION,
    allFiles,
    sources,
    packages,
    aliases: await readAliasConfigs(root, allFiles),
  });
  // Infrastructure (v2): what the project runs on and pays for.
  const infraModel = withInfra(model, await detectInfra(root, allFiles, model));
  // Data models (v3): entities from code and Prisma schemas, with their relations.
  const prismaSources: { path: string; entities: ReturnType<typeof prismaEntities> }[] = [];
  for (const f of allFiles.filter((x) => x.endsWith(".prisma"))) {
    try {
      const abs = path.join(root, f);
      if ((await fs.stat(abs)).size <= MAX_FILE_BYTES)
        prismaSources.push({ path: f, entities: prismaEntities(await fs.readFile(abs, "utf8")) });
    } catch {
      /* unreadable schema: skip */
    }
  }
  const entityModel = withEntities(
    infraModel,
    buildEntities(infraModel, [
      ...sources.map((s) => ({ path: s.path, entities: s.facts?.entities ?? [] })),
      ...prismaSources,
    ]),
  );
  // Data operations: which code reads/writes databases and caches, publishes/consumes queues.
  const withInfraNodes = withDataOps(
    entityModel,
    linkDataOps(
      entityModel,
      sources.map((s) => ({ path: s.path, facts: s.facts ?? emptyFacts() })),
      ctx,
    ),
  );
  // Pinned versions (lockfiles) and declared runtimes, for advisories and lifecycle checks.
  const result = withVersions(
    withInfraNodes,
    await readLockedVersions(root, allFiles),
    await readRuntimes(root, allFiles),
  );
  if (options.stats)
    Object.assign(options.stats, {
      files: sources.length,
      parsed: cache.misses,
      reused: cache.hits,
      ms: Date.now() - started,
    });
  const functions = buildFunctionIndex(
    result,
    sources.map((s) => ({ path: s.path, functions: s.facts?.functions ?? [] })),
    ctx,
  );
  return { model: result, functions };
}
