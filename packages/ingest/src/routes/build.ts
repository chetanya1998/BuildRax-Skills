import path from "node:path";
import { nodeId, type Evidence, type IRNode } from "@buildrax/ir";
import type { Lang } from "../languages.js";
import { owningPackage, type PackageInfo } from "../packages.js";
import { joinPath, type FileFacts, type RawRoute } from "./facts.js";

const posix = path.posix;

export interface RouteSource {
  path: string;
  lang: Lang;
  facts: FileFacts;
  /** External packages this file imports (npm / PyPI top-level names). */
  imports: string[];
}

/** Local name → file it was imported from, per file (built during import resolution). */
export type Bindings = Map<string, Map<string, string>>;

const SERVER_PACKAGES = new Set([
  "express",
  "fastify",
  "hono",
  "koa",
  "koa-router",
  "@koa/router",
  "elysia",
  "@nestjs/common",
  "@nestjs/core",
  "fastapi",
  "flask",
  "starlette",
]);

export interface RouteMeta {
  method: string;
  path?: string;
  framework: string;
  /** `api` for endpoints, `page` for UI routes (Next.js pages). */
  type: "api" | "page";
  handler?: string;
}

/** Next.js file-system route: `app/(shop)/orders/[id]/route.ts` → `/orders/:id`. */
export function nextRoutePath(segments: readonly string[]): string {
  const parts: string[] = [];
  for (const s of segments) {
    if (!s || (s.startsWith("(") && s.endsWith(")")) || s.startsWith("@")) continue; // groups, slots
    const opt = /^\[\[\.\.\.(.+)\]\]$/.exec(s);
    const rest = /^\[\.\.\.(.+)\]$/.exec(s);
    const dyn = /^\[(.+)\]$/.exec(s);
    parts.push(opt ? `*${opt[1]}?` : rest ? `*${rest[1]}` : dyn ? `:${dyn[1]}` : s);
  }
  return joinPath(...parts);
}

function nextRoutes(
  file: string,
  pkg: PackageInfo | undefined,
  facts: FileFacts,
): (RawRoute & { type: RouteMeta["type"] })[] {
  const rel = pkg?.dir ? file.slice(pkg.dir.length + 1) : file;
  const parts = rel.split("/");
  const name = parts.at(-1)!;
  const stem = name.replace(/\.(tsx?|jsx?|mjs|mdx)$/, "");
  const appAt = parts[0] === "app" ? 1 : parts[0] === "src" && parts[1] === "app" ? 2 : -1;
  const pagesAt = parts[0] === "pages" ? 1 : parts[0] === "src" && parts[1] === "pages" ? 2 : -1;
  const base = { line: 1, receiver: "", framework: "nextjs" };
  if (appAt > 0) {
    const dirs = parts.slice(appAt, -1);
    if (stem === "route")
      return facts.httpExports.map((m) => ({
        ...base,
        method: m,
        path: nextRoutePath(dirs),
        handler: m,
        type: "api" as const,
      }));
    if (stem === "page")
      return [{ ...base, method: "PAGE", path: nextRoutePath(dirs), type: "page" }];
    return [];
  }
  if (pagesAt > 0 && !stem.startsWith("_")) {
    const segs = [...parts.slice(pagesAt, -1), stem === "index" ? "" : stem];
    const api = parts[pagesAt] === "api";
    return [
      {
        ...base,
        method: api ? "ANY" : "PAGE",
        path: nextRoutePath(segs),
        type: api ? "api" : "page",
      },
    ];
  }
  return [];
}

/**
 * Turn per-file facts into route nodes. Router mounts are followed across files through import
 * bindings (`app.use('/api', ordersRouter)`, `app.include_router(items.router, prefix=…)`), so
 * a route's path includes every prefix on the way. Unresolvable paths are kept, marked
 * `unresolved`, rather than guessed.
 */
export function buildRoutes(
  sources: readonly RouteSource[],
  packages: readonly PackageInfo[],
  bindings: Bindings,
): IRNode[] {
  const byPath = new Map(sources.map((s) => [s.path, s]));
  const nodes = new Map<string, IRNode>();

  // Incoming mounts per target file: who mounts it, with which prefix, on which receiver.
  type Incoming = {
    from: string;
    receiver: string;
    prefix: string;
    targetReceiver: string;
    line: number;
  };
  const incoming = new Map<string, Incoming[]>();
  for (const s of sources)
    for (const m of s.facts.mounts) {
      const [root, ...rest] = m.target.split(".");
      const local = s.facts.receivers.includes(m.target);
      const file = local ? s.path : bindings.get(s.path)?.get(root!);
      if (!file || !byPath.has(file)) continue;
      const targetReceiver = local ? m.target : rest.length ? rest.join(".") : "*";
      const list = incoming.get(file) ?? [];
      list.push({
        from: s.path,
        receiver: m.receiver,
        prefix: m.prefix,
        targetReceiver,
        line: m.line,
      });
      incoming.set(file, list);
    }

  /** Every full prefix a receiver in a file is reachable under (roots get ""). */
  const prefixesOf = (file: string, receiver: string, seen: Set<string>): string[] => {
    const key = `${file}#${receiver}`;
    if (seen.has(key) || seen.size > 12) return [""];
    const next = new Set(seen).add(key);
    const own = byPath.get(file)?.facts.prefixes[receiver] ?? "";
    const ins = (incoming.get(file) ?? []).filter(
      (m) =>
        (m.targetReceiver === receiver || m.targetReceiver === "*") &&
        !(m.from === file && m.receiver === receiver),
    );
    if (!ins.length) return [joinPath(own)];
    const out = new Set<string>();
    for (const m of ins)
      for (const p of prefixesOf(m.from, m.receiver, next)) out.add(joinPath(p, m.prefix, own));
    return [...out].sort();
  };

  const add = (
    file: string,
    r: RawRoute,
    type: RouteMeta["type"],
    fullPath: string | undefined,
    pkg: PackageInfo | undefined,
  ): void => {
    const scope = pkg?.dir || ".";
    const id =
      fullPath !== undefined
        ? nodeId("route", `${scope}:${r.method} ${fullPath}`)
        : nodeId("route", `${file}:${r.line}:${r.method}`);
    const ev: Evidence =
      fullPath !== undefined
        ? {
            kind: "verified",
            file,
            startLine: r.line,
            detail: `${r.framework} ${r.method} ${fullPath}`,
          }
        : {
            kind: "unresolved",
            file,
            startLine: r.line,
            detail: `${r.framework} route with a computed path`,
          };
    const existing = nodes.get(id);
    if (existing) {
      if (!existing.evidence.some((e) => e.file === ev.file && e.startLine === ev.startLine))
        existing.evidence.push(ev);
      return;
    }
    const meta: RouteMeta = {
      method: r.method,
      ...(fullPath !== undefined ? { path: fullPath } : {}),
      framework: r.framework,
      type,
      ...(r.handler ? { handler: r.handler } : {}),
    };
    nodes.set(id, {
      id,
      kind: "route",
      name: fullPath !== undefined ? `${r.method} ${fullPath}` : `${r.method} (computed path)`,
      parent: nodeId("file", file),
      path: file,
      evidence: [ev],
      meta: meta as unknown as Record<string, unknown>,
    });
  };

  for (const s of [...sources].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    const pkg = owningPackage(s.path, packages);
    if (s.lang !== "python" && pkg?.deps?.includes("next"))
      for (const r of nextRoutes(s.path, pkg, s.facts)) add(s.path, r, r.type, r.path, pkg);

    const serverFile = s.imports.some((i) => SERVER_PACKAGES.has(i)) || incoming.has(s.path);
    // Routes on a conventional name (a plugin's `fastify` parameter) take the imported framework.
    const imported = ["fastify", "hono", "koa", "express", "elysia", "fastapi", "flask"].find((f) =>
      s.imports.some((i) => i === f || i.startsWith(`@${f}/`)),
    );
    for (const raw of s.facts.routes) {
      if (raw.implicit && !serverFile) continue; // `app.get(...)` on an unknown object: not a route
      const r = raw.implicit && imported ? { ...raw, framework: imported } : raw;
      if (r.path === undefined) {
        add(s.path, r, "api", undefined, pkg);
        continue;
      }
      if (r.framework === "nestjs") {
        add(s.path, r, "api", r.path, pkg);
        continue;
      }
      for (const prefix of prefixesOf(s.path, r.receiver, new Set()))
        add(s.path, r, "api", joinPath(prefix, r.path), pkg);
    }
  }
  return [...nodes.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** Which repo file an imported local name refers to, for Python `from x import name` forms. */
export function pythonBindingTarget(name: string, targets: readonly string[]): string | undefined {
  const sub = targets.find(
    (t) => posix.basename(t).replace(/\.py$/, "") === name || t.endsWith(`/${name}/__init__.py`),
  );
  return sub ?? targets[0];
}
