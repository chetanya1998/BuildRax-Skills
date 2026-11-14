import type { EdgeKind, IREdge, IRNode, Model } from "@buildrax/ir";
import { tarjanScc } from "./scc.js";

export type Direction = "downstream" | "upstream" | "both";

/** Read-only adjacency/hierarchy index over an Architecture IR model. */
export class GraphIndex {
  readonly nodes = new Map<string, IRNode>();
  readonly edges: readonly IREdge[];
  private readonly outEdges = new Map<string, IREdge[]>();
  private readonly inEdges = new Map<string, IREdge[]>();
  private readonly childIds = new Map<string, string[]>();

  constructor(readonly model: Model) {
    for (const n of model.nodes) this.nodes.set(n.id, n);
    this.edges = model.edges;
    for (const e of model.edges) {
      push(this.outEdges, e.from, e);
      push(this.inEdges, e.to, e);
    }
    for (const n of model.nodes) if (n.parent) push(this.childIds, n.parent, n.id);
  }

  node(id: string): IRNode | undefined {
    return this.nodes.get(id);
  }
  children(id: string): string[] {
    return this.childIds.get(id) ?? [];
  }
  out(id: string, kinds?: ReadonlySet<EdgeKind>): IREdge[] {
    const all = this.outEdges.get(id) ?? [];
    return kinds ? all.filter((e) => kinds.has(e.kind)) : all;
  }
  in(id: string, kinds?: ReadonlySet<EdgeKind>): IREdge[] {
    const all = this.inEdges.get(id) ?? [];
    return kinds ? all.filter((e) => kinds.has(e.kind)) : all;
  }
  /** Ancestor ids from the nearest parent up to the root. */
  ancestors(id: string): string[] {
    const out: string[] = [];
    let cur = this.nodes.get(id)?.parent;
    while (cur !== undefined) {
      out.push(cur);
      cur = this.nodes.get(cur)?.parent;
    }
    return out;
  }
  /** All descendant ids (depth-first, deterministic order). */
  descendants(id: string): string[] {
    const out: string[] = [];
    const walk = (cur: string): void => {
      for (const c of this.children(cur)) {
        out.push(c);
        walk(c);
      }
    };
    walk(id);
    return out;
  }
  roots(): string[] {
    return this.model.nodes.filter((n) => n.parent === undefined).map((n) => n.id);
  }
  fanIn(id: string): number {
    return new Set((this.inEdges.get(id) ?? []).map((e) => e.from)).size;
  }
  fanOut(id: string): number {
    return new Set((this.outEdges.get(id) ?? []).map((e) => e.to)).size;
  }
}

function push<T>(m: Map<string, T[]>, k: string, v: T): void {
  const l = m.get(k);
  if (l) l.push(v);
  else m.set(k, [v]);
}

export interface TraverseOptions {
  direction: Direction;
  /** Max hops; Infinity for unbounded. */
  depth: number;
  edgeKinds?: ReadonlySet<EdgeKind>;
}

/** BFS from `start`. Returns node id -> hop distance (start = 0). Deterministic. */
export function traverse(
  index: GraphIndex,
  start: string,
  opts: TraverseOptions,
): Map<string, number> {
  const dist = new Map<string, number>([[start, 0]]);
  const queue = [start];
  for (let qi = 0; qi < queue.length; qi++) {
    const cur = queue[qi]!;
    const d = dist.get(cur)!;
    if (d >= opts.depth) continue;
    const next: string[] = [];
    if (opts.direction !== "upstream")
      next.push(...index.out(cur, opts.edgeKinds).map((e) => e.to));
    if (opts.direction !== "downstream")
      next.push(...index.in(cur, opts.edgeKinds).map((e) => e.from));
    for (const n of next) {
      if (!dist.has(n)) {
        dist.set(n, d + 1);
        queue.push(n);
      }
    }
  }
  return dist;
}

/** Shortest directed path (fewest hops) from `from` to `to`, or undefined. */
export function shortestPath(index: GraphIndex, from: string, to: string): string[] | undefined {
  if (from === to) return [from];
  const prev = new Map<string, string>();
  const seen = new Set([from]);
  const queue = [from];
  for (let qi = 0; qi < queue.length; qi++) {
    const cur = queue[qi]!;
    for (const e of index.out(cur)) {
      if (seen.has(e.to)) continue;
      seen.add(e.to);
      prev.set(e.to, cur);
      if (e.to === to) {
        const path = [to];
        while (path[0] !== from) path.unshift(prev.get(path[0]!)!);
        return path;
      }
      queue.push(e.to);
    }
  }
  return undefined;
}

/** Circular dependencies between files (strongly connected components of file->file imports). */
export function fileCycles(index: GraphIndex): string[][] {
  const adj = new Map<string, string[]>();
  const ids: string[] = [];
  for (const n of index.model.nodes) {
    if (n.kind !== "file") continue;
    ids.push(n.id);
    adj.set(
      n.id,
      index
        .out(n.id)
        .filter((e) => index.node(e.to)?.kind === "file")
        .map((e) => e.to),
    );
  }
  return tarjanScc(ids, adj);
}

export interface Hub {
  id: string;
  fanIn: number;
  fanOut: number;
}

/** Most connected nodes of a kind, ranked by fan-in + fan-out (ties broken by id). */
export function hubs(index: GraphIndex, kind: IRNode["kind"], top = 10): Hub[] {
  return index.model.nodes
    .filter((n) => n.kind === kind)
    .map((n) => ({ id: n.id, fanIn: index.fanIn(n.id), fanOut: index.fanOut(n.id) }))
    .filter((h) => h.fanIn + h.fanOut > 0)
    .sort((a, b) => b.fanIn + b.fanOut - (a.fanIn + a.fanOut) || (a.id < b.id ? -1 : 1))
    .slice(0, top);
}

/** Simple ranked substring search over name and path. Case-insensitive. */
export function searchNodes(index: GraphIndex, query: string, limit = 20): IRNode[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const scored: { n: IRNode; s: number }[] = [];
  for (const n of index.model.nodes) {
    const name = n.name.toLowerCase();
    const path = (n.path ?? n.id).toLowerCase();
    let s = 0;
    if (name === q) s = 100;
    else if (name.startsWith(q)) s = 80;
    else if (name.includes(q)) s = 60;
    else if (path.includes(q)) s = 30;
    if (s) scored.push({ n, s: s - (n.kind === "file" ? 0 : -5) });
  }
  return scored
    .sort((a, b) => b.s - a.s || (a.n.id < b.n.id ? -1 : 1))
    .slice(0, limit)
    .map((x) => x.n);
}
