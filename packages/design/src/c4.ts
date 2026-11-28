import { GraphIndex } from "@buildrax/graph";
import type { Evidence, FunctionsFile, IREdge, IRNode, Model } from "@buildrax/ir";
import type { C4Element, C4Model, C4Relation, ElementKind, Provenance } from "./types.js";

const STORE_KINDS = new Set(["database", "cache", "storage", "search"]);
const EXTERNAL_KINDS = new Set(["payments", "email", "llm", "messaging", "auth"]);
const DEPLOY_KINDS = new Set(["compute", "hosting", "cdn"]);
const DATA = new Set(["reads", "writes", "publishes", "consumes"]);
const CODE_EDGES = new Set(["imports", "depends-on", "calls"]);
const MAX_EVIDENCE = 3;
const TEST_FILE =
  /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[jt]sx?$|(^|\/)test_[^/]+\.py$|_test\.py$/;

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const uniq = <T>(xs: Iterable<T>): T[] => [...new Set(xs)];
const byId = <T extends { id: string }>(a: T, b: T): number =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/** Kinds of the model the projection reads, grouped once. */
interface Ctx {
  model: Model;
  index: GraphIndex;
  project?: IRNode;
  /** container element id for each file id */
  containerOfFile: Map<string, string>;
  /** component element id for each file id */
  componentOfFile: Map<string, string>;
  /** container element id for a package module id (for depends-on edges) */
  containerOfModule: Map<string, string>;
  routesByFile: Map<string, IRNode[]>;
}

/** Element id for a model node standing in for a whole infrastructure service. */
const infraElementId = (n: IRNode): string =>
  EXTERNAL_KINDS.has(n.kind) ? `c4:ext:${n.id}` : `c4:store:${n.id}`;

function relationLabel(
  kinds: string[],
  meta: { tables: Set<string>; channels: Set<string> },
  count: number,
): string {
  const verbs = kinds.filter((k) => DATA.has(k));
  const what = [...meta.tables, ...meta.channels].sort();
  if (verbs.length)
    return `${verbs.join(", ")}${what.length ? ` (${what.slice(0, 4).join(", ")}${what.length > 4 ? ", …" : ""})` : ""}`;
  if (kinds.includes("uses")) return "uses";
  if (kinds.includes("http")) return plural(count, "endpoint");
  if (kinds.includes("page")) return plural(count, "page");
  return `imports (${count})`;
}

class RelationBag {
  private readonly rels = new Map<
    string,
    {
      from: string;
      to: string;
      level: 1 | 2 | 3;
      kinds: Set<string>;
      count: number;
      prov: Provenance;
      evidence: Evidence[];
      tables: Set<string>;
      channels: Set<string>;
    }
  >();
  add(
    level: 1 | 2 | 3,
    from: string,
    to: string,
    e: IREdge | { kind: string; evidence: Evidence[]; meta?: Record<string, unknown> },
    prov: Provenance,
  ): void {
    if (from === to) return;
    const id = `${from}->${to}`;
    const r = this.rels.get(id) ?? {
      from,
      to,
      level,
      kinds: new Set<string>(),
      count: 0,
      prov,
      evidence: [],
      tables: new Set<string>(),
      channels: new Set<string>(),
    };
    r.kinds.add(e.kind);
    r.count++;
    if (prov === "code") r.prov = "code";
    for (const ev of e.evidence) if (r.evidence.length < MAX_EVIDENCE) r.evidence.push(ev);
    for (const t of (e.meta?.["tables"] as string[] | undefined) ?? []) r.tables.add(t);
    for (const c of (e.meta?.["channels"] as string[] | undefined) ?? []) r.channels.add(c);
    this.rels.set(id, r);
  }
  list(): C4Relation[] {
    return [...this.rels.entries()]
      .map(([id, r]) => {
        const kinds = [...r.kinds].sort();
        return {
          id,
          level: r.level,
          from: r.from,
          to: r.to,
          kinds,
          label: relationLabel(kinds, r, r.count),
          count: r.count,
          provenance: r.prov,
          evidence: r.evidence,
        };
      })
      .sort(byId);
  }
}

/** Repo folders that are deployable or reusable units: packages, plus top-level folders that serve or consume. */
function findContainers(ctx: Ctx): { module?: IRNode; files: string[] }[] {
  const { model, index } = ctx;
  const files = model.nodes.filter((n) => n.kind === "file");
  const packages = new Set(
    model.nodes.filter((n) => n.kind === "module" && n.meta?.["package"]).map((n) => n.id),
  );
  const owner = (fileId: string): string | undefined =>
    index.ancestors(fileId).find((a) => packages.has(a));
  const groups = new Map<string, string[]>();
  const loose: string[] = [];
  for (const f of files) {
    const p = owner(f.id);
    if (p) groups.set(p, [...(groups.get(p) ?? []), f.id]);
    else loose.push(f.id);
  }
  // Top-level folders outside any package that serve endpoints or consume queues are units too.
  const active = (fileIds: string[]): boolean =>
    fileIds.some(
      (f) =>
        (ctx.routesByFile.get(f)?.length ?? 0) > 0 ||
        index.out(f).some((e) => e.kind === "consumes"),
    );
  const rest: string[] = [];
  const byTop = new Map<string, string[]>();
  for (const f of loose) {
    const top = index
      .ancestors(f)
      .filter((a) => index.node(a)?.kind === "module")
      .at(-1);
    if (top) byTop.set(top, [...(byTop.get(top) ?? []), f]);
    else rest.push(f);
  }
  for (const [top, fs] of byTop) {
    if (active(fs)) groups.set(top, fs);
    else rest.push(...fs);
  }
  const out: { module?: IRNode; files: string[] }[] = [...groups.entries()]
    .map(([m, fs]) => ({ module: index.node(m)!, files: fs.sort() }))
    .sort((a, b) => (a.module.id < b.module.id ? -1 : 1));
  if (rest.length && active(rest)) out.push({ files: rest.sort() });
  return out;
}

/** Descend through single-folder chains (`src`) so components are the folders that matter. */
function componentRoots(
  index: GraphIndex,
  mod: IRNode,
  isContainer: (id: string) => boolean,
): { comps: string[]; skipped: string[] } {
  let cur = mod.id;
  const skipped: string[] = [];
  for (let i = 0; i < 3; i++) {
    const kids = index
      .children(cur)
      .filter((c) => index.node(c)?.kind === "module" && !isContainer(c));
    const files = index.children(cur).filter((c) => index.node(c)?.kind === "file");
    if (kids.length === 1 && !files.length) {
      skipped.push(cur);
      cur = kids[0]!;
      continue;
    }
    return { comps: kids, skipped: [...skipped, cur] };
  }
  return { comps: [cur], skipped };
}

function tagsFor(ctx: Ctx, fileIds: readonly string[]): string[] {
  const { index, model } = ctx;
  const tags = new Set<string>();
  const set = new Set(fileIds);
  for (const f of fileIds) {
    for (const r of ctx.routesByFile.get(f) ?? [])
      tags.add(r.meta?.["type"] === "page" ? "pages" : "endpoints");
    for (const e of index.out(f)) {
      if (e.kind === "reads" || e.kind === "writes") tags.add("data access");
      if (e.kind === "publishes") tags.add("messaging");
      if (e.kind === "consumes") tags.add("worker");
    }
  }
  if (model.nodes.some((n) => n.kind === "entity" && n.path && set.has(`file:${n.path}`)))
    tags.add("models");
  if (fileIds.length && fileIds.every((f) => TEST_FILE.test(f.slice(5)))) tags.add("tests");
  return [...tags].sort();
}

function technologyFor(ctx: Ctx, fileIds: readonly string[], deployed: IRNode[]): string[] {
  const frameworks = uniq(
    fileIds.flatMap((f) =>
      (ctx.routesByFile.get(f) ?? []).map((r) => String(r.meta?.["framework"] ?? "")),
    ),
  ).filter(Boolean);
  const langs = uniq(
    fileIds.map((f) => ctx.index.node(f)?.language).filter((l): l is string => !!l),
  );
  const runtimes = uniq(
    deployed.map((d) => String(d.meta?.["runtime"] ?? d.meta?.["engine"] ?? "")).filter(Boolean),
  );
  return [...frameworks.sort(), ...langs.sort(), ...runtimes.sort()];
}

/**
 * C4 view of the model (levels 1–3; level 4 is the files and functions themselves). Containers are
 * packages and serving folders; data stores and queues are containers; paid third-party services
 * are external systems; compute and hosting are deployment, tied to a container only when config
 * says which folder it builds.
 */
export function buildC4(model: Model, functions?: FunctionsFile): C4Model {
  const index = new GraphIndex(model);
  const routesByFile = new Map<string, IRNode[]>();
  for (const n of model.nodes)
    if (n.kind === "route" && n.parent?.startsWith("file:"))
      routesByFile.set(n.parent, [...(routesByFile.get(n.parent) ?? []), n]);
  const ctx: Ctx = {
    model,
    index,
    project: model.nodes.find((n) => n.kind === "project"),
    containerOfFile: new Map(),
    componentOfFile: new Map(),
    containerOfModule: new Map(),
    routesByFile,
  };
  const fnCount = new Map<string, number>(
    (functions?.files ?? []).map((f) => [`file:${f.path}`, f.functions.length]),
  );
  const countFns = (fileIds: readonly string[]): number | undefined =>
    functions ? fileIds.reduce((s, f) => s + (fnCount.get(f) ?? 0), 0) : undefined;

  const elements: C4Element[] = [];
  const systemId = "c4:system";
  const systemName = ctx.project?.name ?? model.meta.repo;

  // Deployment: compute/hosting nodes, tied to a container through compose `build` contexts.
  const deployNodes = model.nodes.filter((n) => DEPLOY_KINDS.has(n.kind));
  const tied = new Set<string>();

  // ---- containers
  const containers = findContainers(ctx);
  const containerIds = new Set(containers.map((c) => (c.module ? c.module.id : "")));
  for (const c of containers) {
    const id = c.module ? `c4:container:${c.module.id}` : "c4:container:root";
    for (const f of c.files) ctx.containerOfFile.set(f, id);
    if (c.module) ctx.containerOfModule.set(c.module.id, id);
  }
  const crossImports = new Map<string, number>(); // container id → imported from other containers
  for (const e of model.edges) {
    if (!CODE_EDGES.has(e.kind)) continue;
    const from = ctx.containerOfFile.get(e.from);
    const to = ctx.containerOfFile.get(e.to) ?? ctx.containerOfModule.get(e.to);
    if (from && to && from !== to) crossImports.set(to, (crossImports.get(to) ?? 0) + 1);
  }
  for (const c of containers) {
    const id = c.module ? `c4:container:${c.module.id}` : "c4:container:root";
    const path = c.module?.path ?? ".";
    const deployed = deployNodes.filter((d) => {
      const bc = d.meta?.["buildContext"];
      return typeof bc === "string" && (bc === path || (bc === "." && path === "."));
    });
    for (const d of deployed) tied.add(d.id);
    const routes = c.files.flatMap((f) => routesByFile.get(f) ?? []);
    const api = routes.filter((r) => r.meta?.["type"] !== "page").length;
    const pages = routes.length - api;
    const consumes = c.files.some((f) => index.out(f).some((e) => e.kind === "consumes"));
    const kind: ElementKind = routes.length
      ? "app"
      : consumes
        ? "worker"
        : deployed.length
          ? "service"
          : crossImports.get(id)
            ? "library"
            : "app";
    const tech = technologyFor(ctx, c.files, deployed);
    const tags = tagsFor(ctx, c.files);
    const parts = [
      api ? plural(api, "endpoint") : "",
      pages ? plural(pages, "page") : "",
      plural(c.files.length, "file"),
    ].filter(Boolean);
    const kindWord =
      {
        app: "Application",
        worker: "Background worker",
        service: "Service",
        library: "Shared library",
      }[kind as "app"] ?? "Application";
    elements.push({
      id,
      level: 2,
      kind,
      name: c.module?.name ?? `${systemName} (root)`,
      parent: systemId,
      technology: tech,
      description: `${kindWord}${tech.length ? ` (${tech.slice(0, 3).join(", ")})` : ""}: ${parts.join(", ")}.`,
      tags,
      nodes: c.module ? [c.module.id] : c.files.slice(0, 50),
      ...(deployed.length ? { deployedAs: deployed.map((d) => d.id).sort() } : {}),
      provenance: "code",
      files: c.files.length,
      ...(countFns(c.files) !== undefined ? { functions: countFns(c.files) } : {}),
    });

    // ---- components (level 3)
    const isContainer = (mid: string): boolean => containerIds.has(mid);
    const roots = c.module
      ? componentRoots(index, c.module, isContainer)
      : { comps: [], skipped: [] };
    const assigned = new Set<string>();
    for (const cm of roots.comps) {
      const mod = index.node(cm)!;
      const files = index.descendants(cm).filter((d) => c.files.includes(d));
      if (!files.length) continue;
      const cid = `c4:component:${cm}`;
      for (const f of files) {
        ctx.componentOfFile.set(f, cid);
        assigned.add(f);
      }
      const ctech = technologyFor(ctx, files, []);
      elements.push({
        id: cid,
        level: 3,
        kind: "component",
        name: mod.path ?? mod.name,
        parent: id,
        technology: ctech,
        description: `Folder ${mod.path ?? mod.name}: ${plural(files.length, "file")}${tagsFor(ctx, files).length ? `; ${tagsFor(ctx, files).join(", ")}` : ""}.`,
        tags: tagsFor(ctx, files),
        nodes: [cm],
        provenance: "code",
        files: files.length,
        ...(countFns(files) !== undefined ? { functions: countFns(files) } : {}),
      });
    }
    const loose = c.files.filter((f) => !assigned.has(f));
    if (loose.length) {
      const cid = `${id.replace("c4:container:", "c4:component:")}#files`;
      for (const f of loose) ctx.componentOfFile.set(f, cid);
      const where = roots.skipped.at(-1) ? (index.node(roots.skipped.at(-1)!)?.path ?? path) : path;
      elements.push({
        id: cid,
        level: 3,
        kind: "component",
        name: `${where === "." ? "" : `${where}/`}*`,
        parent: id,
        technology: technologyFor(ctx, loose, []),
        description: `Other files in ${where}: ${plural(loose.length, "file")}${tagsFor(ctx, loose).length ? `; ${tagsFor(ctx, loose).join(", ")}` : ""}.`,
        tags: tagsFor(ctx, loose),
        nodes: loose.slice(0, 50),
        provenance: "code",
        files: loose.length,
        ...(countFns(loose) !== undefined ? { functions: countFns(loose) } : {}),
      });
    }
  }

  // ---- data stores, queues and external systems
  const infra = model.nodes.filter(
    (n) => STORE_KINDS.has(n.kind) || n.kind === "queue" || EXTERNAL_KINDS.has(n.kind),
  );
  for (const n of infra) {
    const ext = EXTERNAL_KINDS.has(n.kind);
    const engine = String(n.meta?.["engine"] ?? "");
    const sources = (n.meta?.["sources"] as string[] | undefined) ?? [];
    const fromCode =
      sources.some((s) => s === "sdk") ||
      model.edges.some((e) => e.to === n.id && e.from.startsWith("file:"));
    elements.push({
      id: infraElementId(n),
      level: ext ? 1 : 2,
      kind: ext ? "external-system" : n.kind === "queue" ? "queue" : "datastore",
      name: n.name,
      ...(ext ? {} : { parent: systemId }),
      technology: uniq(
        [
          engine,
          String(n.meta?.["provider"] ?? ""),
          n.meta?.["version"] ? `${engine} ${String(n.meta["version"])}` : "",
        ].filter(Boolean),
      ),
      description: `${ext ? "External service" : n.kind === "queue" ? "Queue" : n.kind === "cache" ? "Cache" : n.kind === "storage" ? "Object storage" : n.kind === "search" ? "Search index" : "Database"}: ${n.name}${sources.length ? `, found in ${sources.join(", ")}` : ""}.`,
      tags: [n.kind],
      nodes: [n.id],
      provenance: fromCode ? "code" : "config",
    });
  }

  // ---- system and people (level 1)
  const allRoutes = model.nodes.filter((n) => n.kind === "route");
  const apiRoutes = allRoutes.filter((r) => r.meta?.["type"] !== "page");
  const pageRoutes = allRoutes.filter((r) => r.meta?.["type"] === "page");
  const containerEls = elements.filter((e) => e.level === 2 && e.id.startsWith("c4:container:"));
  elements.push({
    id: systemId,
    level: 1,
    kind: "system",
    name: systemName,
    technology: [...model.meta.languages],
    description: `The system in this repository: ${plural(containerEls.length, "application container")}, ${plural(elements.filter((e) => e.kind === "datastore" || e.kind === "queue").length, "data store or queue", "data stores and queues")}.`,
    tags: [],
    nodes: ctx.project ? [ctx.project.id] : [],
    provenance: "code",
  });
  const people: { id: string; name: string; routes: IRNode[]; what: string }[] = [
    { id: "c4:person:web-users", name: "Web users", routes: pageRoutes, what: "page" },
    { id: "c4:person:api-clients", name: "API clients", routes: apiRoutes, what: "endpoint" },
  ];
  const rel = new RelationBag();
  for (const p of people) {
    if (!p.routes.length) continue;
    elements.push({
      id: p.id,
      level: 1,
      kind: "person",
      name: p.name,
      technology: [],
      description: `Whoever uses the ${plural(p.routes.length, p.what)} found in code; who they are is not in the code.`,
      tags: [],
      nodes: [],
      provenance: "inferred",
    });
    const ev = (r: IRNode) => ({
      kind: p.what === "page" ? "page" : "http",
      evidence: r.evidence.slice(0, 1),
    });
    for (const r of p.routes) {
      rel.add(1, p.id, systemId, ev(r), "code");
      const c = ctx.containerOfFile.get(r.parent ?? "");
      if (c) rel.add(2, p.id, c, ev(r), "code");
    }
  }

  // ---- relationships from model edges
  for (const e of model.edges) {
    const fromC = ctx.containerOfFile.get(e.from);
    if (!fromC) {
      // compose `depends_on` between deployment and data stores, mapped to containers.
      const fromNode = index.node(e.from);
      const toNode = index.node(e.to);
      if (
        e.kind === "uses" &&
        fromNode &&
        toNode &&
        DEPLOY_KINDS.has(fromNode.kind) &&
        !DEPLOY_KINDS.has(toNode.kind)
      ) {
        const owner = containerEls.find((c) => c.deployedAs?.includes(fromNode.id));
        if (owner && infra.includes(toNode))
          rel.add(2, owner.id, infraElementId(toNode), e, "config");
      }
      continue;
    }
    const fromComp = ctx.componentOfFile.get(e.from);
    const target = index.node(e.to);
    if (!target) continue;
    if (CODE_EDGES.has(e.kind)) {
      const toC = ctx.containerOfFile.get(e.to) ?? ctx.containerOfModule.get(e.to);
      if (toC && toC !== fromC) {
        rel.add(2, fromC, toC, e, "code");
        if (fromComp) rel.add(3, fromComp, ctx.componentOfFile.get(e.to) ?? toC, e, "code");
      } else if (toC === fromC && fromComp) {
        const toComp = ctx.componentOfFile.get(e.to);
        if (toComp) rel.add(3, fromComp, toComp, e, "code");
      }
      continue;
    }
    if ((DATA.has(e.kind) || e.kind === "uses") && infra.includes(target)) {
      const to = infraElementId(target);
      rel.add(2, fromC, to, e, "code");
      if (fromComp) rel.add(3, fromComp, to, e, "code");
      if (EXTERNAL_KINDS.has(target.kind)) rel.add(1, systemId, to, e, "code");
    }
  }

  const relations = rel.list();
  // A `uses` (client imported) next to proven data operations adds nothing: keep the stronger one.
  for (const r of relations)
    if (r.kinds.length > 1 && r.kinds.includes("uses") && r.kinds.some((k) => DATA.has(k))) {
      r.kinds = r.kinds.filter((k) => k !== "uses");
      r.label = r.label.replace(/^uses$/, r.label);
    }

  return {
    elements: elements.sort((a, b) => a.level - b.level || byId(a, b)),
    relations,
    deployment: deployNodes
      .filter((d) => !tied.has(d.id))
      .map((d) => d.id)
      .sort(),
  };
}
