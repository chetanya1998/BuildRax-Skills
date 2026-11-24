import type { Evidence, IRNode } from "@buildrax/ir";
import type { GraphIndex } from "./graph-index.js";

/** Node kinds that are infrastructure (databases, queues, …), mirrored from the IR. */
const INFRA = new Set([
  "compute",
  "hosting",
  "database",
  "cache",
  "queue",
  "storage",
  "cdn",
  "email",
  "payments",
  "llm",
  "messaging",
  "search",
  "auth",
]);

export interface RouteInfo {
  id: string;
  method: string;
  path?: string;
  framework: string;
  type: "api" | "page";
  file?: string;
  line?: number;
  handler?: string;
  /** False when the path is computed at runtime (shown, never guessed). */
  resolved: boolean;
}

export function routeInfo(n: IRNode): RouteInfo {
  const m = (n.meta ?? {}) as Record<string, unknown>;
  const ev = n.evidence[0];
  return {
    id: n.id,
    method: String(m["method"] ?? "ANY"),
    ...(typeof m["path"] === "string" ? { path: m["path"] as string } : {}),
    framework: String(m["framework"] ?? "unknown"),
    type: m["type"] === "page" ? "page" : "api",
    ...(n.path ? { file: n.path } : {}),
    ...(ev?.startLine ? { line: ev.startLine } : {}),
    ...(typeof m["handler"] === "string" ? { handler: m["handler"] as string } : {}),
    resolved: typeof m["path"] === "string",
  };
}

/** Endpoints in the model: API routes first, then pages; by path, then method. */
export function listRoutes(index: GraphIndex): RouteInfo[] {
  return index.model.nodes
    .filter((n) => n.kind === "route")
    .map(routeInfo)
    .sort(
      (a, b) =>
        (a.type === b.type ? 0 : a.type === "api" ? -1 : 1) ||
        (a.path ?? "~").localeCompare(b.path ?? "~") ||
        a.method.localeCompare(b.method) ||
        a.id.localeCompare(b.id),
    );
}

/**
 * Find routes by id, `METHOD /path`, or path alone (every method). Case-insensitive method;
 * `{id}`, `:id` and `[id]` parameter styles match each other.
 */
export function findRoutes(index: GraphIndex, query: string): RouteInfo[] {
  const all = listRoutes(index);
  const q = query.trim();
  const byId = all.filter((r) => r.id === q);
  if (byId.length) return byId;
  const norm = (p: string) =>
    p.replace(/\{([^}]+)\}|\[([^\]]+)\]/g, ":$1$2").replace(/\/$/, "") || "/";
  const m = /^([A-Za-z]+)\s+(\/\S*)$/.exec(q);
  const method = m ? m[1]!.toUpperCase() : undefined;
  const path = norm(m ? m[2]! : q);
  return all.filter(
    (r) => r.path !== undefined && norm(r.path) === path && (!method || r.method === method),
  );
}

export interface FlowStep {
  /** Step number in reading order (breadth-first from the endpoint). */
  n: number;
  /** Distance from the handler's file. */
  hop: number;
  from: string;
  to: string;
  kind: string;
  evidence?: Evidence;
}

export interface Flow {
  route: RouteInfo;
  /** File that defines the handler. */
  entry: string;
  steps: FlowStep[];
  participants: {
    files: string[];
    /** Databases, caches, queues, storage and paid APIs reached. */
    infra: string[];
    /** Third-party packages used along the way. */
    external: string[];
    /** Other workspace packages depended on (not followed further). */
    packages: string[];
  };
  /** True when the depth or step limit cut the walk short. */
  truncated: boolean;
}

/**
 * What an endpoint can reach, statically: starting from the file that defines the handler, follow
 * `imports` between files, `uses` into infrastructure, and note external packages and workspace
 * packages. File level: it shows everything the handler's file can reach, not one runtime path.
 */
export function routeFlow(
  index: GraphIndex,
  routeId: string,
  opts: { depth?: number; maxSteps?: number } = {},
): Flow | undefined {
  const node = index.node(routeId);
  if (!node || node.kind !== "route" || !node.parent) return undefined;
  const depth = opts.depth ?? 6;
  const maxSteps = opts.maxSteps ?? 300;
  const steps: FlowStep[] = [];
  const files = new Set([node.parent]);
  const infra = new Set<string>();
  const external = new Set<string>();
  const packages = new Set<string>();
  let truncated = false;
  let frontier = [node.parent];
  for (let hop = 1; frontier.length && hop <= depth; hop++) {
    const next: string[] = [];
    for (const from of [...frontier].sort()) {
      const out = [...index.out(from)].sort((a, b) => (a.id < b.id ? -1 : 1));
      for (const e of out) {
        const to = index.node(e.to);
        if (!to) continue;
        const follow = e.kind === "imports" && to.kind === "file" && !files.has(to.id);
        const leaf =
          (e.kind === "uses" && INFRA.has(to.kind) && !infra.has(to.id)) ||
          (to.kind === "external" && !external.has(to.id)) ||
          (to.kind === "module" && e.kind === "depends-on" && !packages.has(to.id));
        if (!follow && !leaf) continue;
        if (steps.length >= maxSteps) {
          truncated = true;
          break;
        }
        steps.push({
          n: steps.length + 1,
          hop,
          from,
          to: to.id,
          kind: e.kind,
          evidence: e.evidence[0],
        });
        if (follow) {
          files.add(to.id);
          next.push(to.id);
        } else if (INFRA.has(to.kind)) infra.add(to.id);
        else if (to.kind === "external") external.add(to.id);
        else packages.add(to.id);
      }
    }
    if (hop === depth && next.length) truncated = true;
    frontier = next;
  }
  return {
    route: routeInfo(node),
    entry: node.parent,
    steps,
    participants: {
      files: [...files].sort(),
      infra: [...infra].sort(),
      external: [...external].sort(),
      packages: [...packages].sort(),
    },
    truncated,
  };
}

/** Endpoints whose flow reaches a given node (e.g. which routes touch the orders database). */
export function routesReaching(
  index: GraphIndex,
  targetId: string,
  opts: { depth?: number } = {},
): RouteInfo[] {
  return listRoutes(index).filter((r) => {
    const f = routeFlow(index, r.id, { depth: opts.depth, maxSteps: 2000 });
    return !!f && (f.entry === targetId || f.steps.some((s) => s.to === targetId));
  });
}
