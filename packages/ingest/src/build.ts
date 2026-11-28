import path from "node:path";
import {
  IR_SCHEMA_VERSION,
  edgeId,
  nodeId,
  type EdgeKind,
  type Evidence,
  type IREdge,
  type IRNode,
  type Model,
} from "@buildrax/ir";
import { languageLabel, type Lang } from "./languages.js";
import type { RawImport } from "./parser.js";
import type { FileFacts } from "./routes/facts.js";
import { buildRoutes, pythonBindingTarget, type Bindings } from "./routes/build.js";
import { aliasCandidates, type AliasConfig } from "./tsconfig.js";
import { groupDirFor, owningPackage, type PackageInfo } from "./packages.js";
import {
  isNodeBuiltin,
  isRelativeSpecifier,
  looksLikePathAlias,
  npmPackageName,
  resolvePython,
  resolveRelativeJs,
  resolveRepoPathJs,
} from "./resolve.js";

const posix = path.posix;

export interface SourceFile {
  path: string;
  lang: Lang;
  lines: number;
  imports: RawImport[];
  /** Endpoint facts from the same parse (absent in hand-built inputs). */
  facts?: FileFacts;
}

export interface BuildInput {
  repoName: string;
  scannedAt: string;
  version: string;
  allFiles: readonly string[];
  sources: readonly SourceFile[];
  packages: readonly PackageInfo[];
  /** tsconfig/jsconfig path aliases (nearest config first). */
  aliases?: readonly AliasConfig[];
}

function addEvidence(list: Evidence[], ev: Evidence): void {
  if (!list.some((e) => e.kind === ev.kind && e.file === ev.file && e.startLine === ev.startLine)) {
    list.push(ev);
  }
}

/** Pure assembly of the Architecture IR from already-extracted facts. Deterministic output. */
/** What later passes (data operations) need from building the model. */
export interface BuildContext {
  /** Local import name → repo file it comes from, per file. */
  bindings: Bindings;
  /** External packages each file imports (npm names, lower-cased PyPI names). */
  externalImports: Map<string, Set<string>>;
  /** Local import name → external package or workspace package (module) node id, per file. */
  externalBindings: Bindings;
}

export function buildModel(input: BuildInput): Model {
  return buildModelWithContext(input).model;
}

export function buildModelWithContext(input: BuildInput): { model: Model } & BuildContext {
  const nodes = new Map<string, IRNode>();
  const edges = new Map<string, IREdge>();
  const files = new Set(input.allFiles);
  const projectId = nodeId("project", input.repoName);

  nodes.set(projectId, {
    id: projectId,
    kind: "project",
    name: input.repoName,
    evidence: [{ kind: "config", detail: "repository root" }],
  });

  // Only packages that own at least one source file become modules.
  const ownerOf = new Map<string, PackageInfo | undefined>();
  for (const s of input.sources) ownerOf.set(s.path, owningPackage(s.path, input.packages));
  const usedPackages = new Set([...ownerOf.values()].filter((p): p is PackageInfo => !!p));

  const packageModuleId = (p: PackageInfo): string => nodeId("module", p.dir || ".");
  for (const p of [...usedPackages].sort((a, b) => a.dir.localeCompare(b.dir))) {
    nodes.set(packageModuleId(p), {
      id: packageModuleId(p),
      kind: "module",
      name: p.name ?? (p.dir ? posix.basename(p.dir) : input.repoName),
      parent: projectId,
      path: p.dir || ".",
      evidence: [{ kind: "config", file: p.manifest, detail: `${p.ecosystem} package` }],
      meta: { package: true, ecosystem: p.ecosystem },
    });
  }

  const fileParent = (file: string): string => {
    const pkg = ownerOf.get(file);
    const pkgId = pkg ? packageModuleId(pkg) : projectId;
    const dir = groupDirFor(file, pkg?.dir ?? "");
    if (!dir) return pkgId;
    const id = nodeId("module", dir);
    if (!nodes.has(id)) {
      nodes.set(id, {
        id,
        kind: "module",
        name: posix.basename(dir),
        parent: pkgId,
        path: dir,
        evidence: [{ kind: "inferred", file: dir, detail: "directory grouping" }],
      });
    }
    return id;
  };

  for (const s of input.sources) {
    const id = nodeId("file", s.path);
    nodes.set(id, {
      id,
      kind: "file",
      name: posix.basename(s.path),
      parent: fileParent(s.path),
      path: s.path,
      language: languageLabel(s.lang),
      evidence: [{ kind: "verified", file: s.path, startLine: 1, endLine: Math.max(1, s.lines) }],
      meta: { lines: s.lines },
    });
  }

  const sourceSet = new Set(input.sources.map((s) => s.path));
  const workspaceNames = new Map<string, PackageInfo>();
  for (const p of usedPackages) if (p.ecosystem === "npm" && p.name) workspaceNames.set(p.name, p);

  const link = (from: string, kind: EdgeKind, to: string, ev: Evidence): void => {
    if (from === to) return;
    const id = edgeId(from, kind, to);
    const existing = edges.get(id);
    if (existing) addEvidence(existing.evidence, ev);
    else edges.set(id, { id, from, to, kind, evidence: [ev] });
  };

  const ensureTarget = (
    kind: "external" | "unresolved",
    key: string,
    ev: Evidence,
    ecosystem?: "npm" | "pypi",
  ): string => {
    const id = nodeId(kind, key);
    if (!nodes.has(id)) {
      nodes.set(id, {
        id,
        kind,
        name: key,
        parent: projectId,
        evidence: [ev],
        ...(ecosystem ? { meta: { ecosystem } } : {}),
      });
    }
    return id;
  };

  // Local import names → the repo file they come from (to follow router mounts across files).
  const bindings: Bindings = new Map();
  const externalImports = new Map<string, Set<string>>();
  const externalBindings: Bindings = new Map();
  const bindExternal = (file: string, locals: readonly string[] | undefined, id: string): void => {
    if (!locals?.length) return;
    const m = externalBindings.get(file) ?? new Map<string, string>();
    for (const l of locals) m.set(l, id);
    externalBindings.set(file, m);
  };
  const bind = (file: string, locals: readonly string[] | undefined, target: string): void => {
    if (!locals?.length) return;
    const m = bindings.get(file) ?? new Map<string, string>();
    for (const l of locals) m.set(l, target);
    bindings.set(file, m);
  };
  const usesExternal = (file: string, name: string): void => {
    const set = externalImports.get(file) ?? new Set<string>();
    set.add(name);
    externalImports.set(file, set);
  };

  for (const s of input.sources) {
    const from = nodeId("file", s.path);
    const pkg = ownerOf.get(s.path);
    const roots = [pkg?.dir ?? "", pkg ? posix.join(pkg.dir, "src") : "src", ""].filter(
      (r, i, a) => a.indexOf(r) === i,
    );
    for (const imp of s.imports) {
      const ev: Evidence = {
        kind: "verified",
        file: s.path,
        startLine: imp.line,
        detail: imp.specifier,
      };
      if (s.lang === "python") {
        const res = resolvePython(s.path, imp.specifier, imp.names ?? [], roots, files);
        for (const t of res.targets)
          if (sourceSet.has(t)) link(from, "imports", nodeId("file", t), ev);
        const local = res.targets.filter((t) => sourceSet.has(t));
        if (local.length && imp.locals)
          imp.locals.forEach((l, i) => {
            const t = imp.names?.length ? pythonBindingTarget(imp.names[i] ?? l, local) : local[0];
            if (t) bind(s.path, [l], t);
          });
        if (res.external) {
          usesExternal(s.path, res.external.toLowerCase());
          const xid = ensureTarget("external", res.external, ev, "pypi");
          link(from, "depends-on", xid, ev);
          bindExternal(s.path, imp.locals, xid);
        }
        if (res.unresolved) {
          const uev: Evidence = { ...ev, kind: "unresolved" };
          link(from, "depends-on", ensureTarget("unresolved", imp.specifier, uev), uev);
        }
        continue;
      }
      const spec = imp.specifier;
      // tsconfig/jsconfig paths and baseUrl (`@/lib/db`, `components/Button`).
      const aliased =
        !isRelativeSpecifier(spec) && input.aliases?.length
          ? aliasCandidates(input.aliases, s.path, spec)
              .map((c) => resolveRepoPathJs(c, files))
              .find((t): t is string => !!t)
          : undefined;
      if (aliased) {
        if (sourceSet.has(aliased)) {
          link(from, "imports", nodeId("file", aliased), {
            ...ev,
            detail: `${spec} (tsconfig paths)`,
          });
          bind(s.path, imp.locals, aliased);
        }
      } else if (isRelativeSpecifier(spec)) {
        const target = resolveRelativeJs(s.path, spec, files);
        if (target && sourceSet.has(target)) {
          link(from, "imports", nodeId("file", target), ev);
          bind(s.path, imp.locals, target);
        } else if (!target) {
          const uev: Evidence = { ...ev, kind: "unresolved" };
          link(from, "depends-on", ensureTarget("unresolved", spec, uev), uev);
        }
      } else if (looksLikePathAlias(spec)) {
        const uev: Evidence = {
          ...ev,
          kind: "unresolved",
          detail: `${spec} (path alias; tsconfig paths not supported yet)`,
        };
        link(from, "depends-on", ensureTarget("unresolved", spec, uev), uev);
      } else if (!isNodeBuiltin(spec)) {
        const name = npmPackageName(spec);
        const ws = workspaceNames.get(name);
        if (ws) {
          link(from, "depends-on", packageModuleId(ws), {
            ...ev,
            kind: "config",
            detail: `workspace package ${name}`,
          });
          bindExternal(s.path, imp.locals, packageModuleId(ws));
        } else {
          usesExternal(s.path, name);
          const xid = ensureTarget("external", name, ev, "npm");
          link(from, "depends-on", xid, ev);
          bindExternal(s.path, imp.locals, xid);
        }
      }
    }
  }

  // Endpoints (routes) from framework conventions, with prefixes followed across files.
  for (const r of buildRoutes(
    input.sources.map((s) => ({
      path: s.path,
      lang: s.lang,
      facts: s.facts ?? {
        routes: [],
        mounts: [],
        prefixes: {},
        httpExports: [],
        useServer: false,
        receivers: [],
      },
      imports: [...(externalImports.get(s.path) ?? [])],
    })),
    input.packages,
    bindings,
  ))
    nodes.set(r.id, r);

  const byId = <T extends { id: string }>(a: T, b: T): number =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  const languages = [...new Set(input.sources.map((s) => languageLabel(s.lang)))].sort();
  const model: Model = {
    schemaVersion: IR_SCHEMA_VERSION,
    meta: {
      repo: input.repoName,
      scannedAt: input.scannedAt,
      generator: { name: "buildrax", version: input.version },
      languages,
      stats: { files: input.sources.length, nodes: nodes.size, edges: edges.size },
    },
    nodes: [...nodes.values()].sort(byId),
    edges: [...edges.values()].sort(byId),
  };
  return { model, bindings, externalImports, externalBindings };
}
