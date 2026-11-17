import { GraphIndex, searchNodes } from "@buildrax/graph";
import type { Evidence, Model } from "@buildrax/ir";
import { loadModel } from "./data.js";

export type TraceDirection = "up" | "down";

export interface TraceHit {
  id: string;
  path: string;
  kind: string;
  distance: number;
  /** The node this one was reached from, and the first evidence anchor for that link. */
  via: { from: string; evidence?: Evidence };
}

export interface TraceResult {
  target: { id: string; path: string; kind: string };
  /** "down" = what the target depends on; "up" = what depends on it (impact of changing it). */
  direction: TraceDirection;
  depth: number;
  hits: TraceHit[];
  /** File nodes among the hits (the practical blast radius). */
  files: number;
}

const label = (model: GraphIndex, id: string): string =>
  model.node(id)?.path ?? model.node(id)?.name ?? id;

/** Resolve a user-typed target: exact id, then exact path or name, then best search match. */
export function resolveTarget(model: Model, query: string): string | undefined {
  const index = new GraphIndex(model);
  if (index.node(query)) return query;
  const exact = model.nodes.filter((n) => n.path === query || n.name === query);
  if (exact.length === 1) return exact[0]!.id;
  const best = searchNodes(index, query, 1)[0];
  return best?.id;
}

export function traceModel(
  model: Model,
  targetQuery: string,
  opts: { direction?: TraceDirection; depth?: number } = {},
): TraceResult {
  const id = resolveTarget(model, targetQuery);
  if (!id)
    throw new Error(`no node matches "${targetQuery}". Try a path from \`buildrax digest\`.`);
  const index = new GraphIndex(model);
  const direction = opts.direction ?? "up";
  const depth = opts.depth && opts.depth > 0 ? opts.depth : Infinity;
  const seen = new Map<string, TraceHit>();
  const queue: string[] = [id];
  const dist = new Map<string, number>([[id, 0]]);
  for (let qi = 0; qi < queue.length; qi++) {
    const cur = queue[qi]!;
    const d = dist.get(cur)!;
    if (d >= depth) continue;
    const edges = direction === "down" ? index.out(cur) : index.in(cur);
    for (const e of edges) {
      const next = direction === "down" ? e.to : e.from;
      if (dist.has(next)) continue;
      dist.set(next, d + 1);
      queue.push(next);
      seen.set(next, {
        id: next,
        path: label(index, next),
        kind: index.node(next)!.kind,
        distance: d + 1,
        via: { from: cur, evidence: e.evidence[0] },
      });
    }
  }
  const hits = [...seen.values()].sort((a, b) => a.distance - b.distance || (a.id < b.id ? -1 : 1));
  const t = index.node(id)!;
  return {
    target: { id, path: label(index, id), kind: t.kind },
    direction,
    depth: Number.isFinite(depth) ? depth : 0,
    hits,
    files: hits.filter((h) => h.kind === "file").length,
  };
}

export async function traceCommand(
  repo: string,
  target: string,
  opts: { direction?: TraceDirection; depth?: number } = {},
): Promise<TraceResult> {
  return traceModel(await loadModel(repo), target, opts);
}

export function formatTrace(r: TraceResult): string {
  const what = r.direction === "up" ? "depends on" : "is depended on by";
  const head =
    r.direction === "up"
      ? `Everything that depends on ${r.target.path} (what could break if it changes)`
      : `Everything ${r.target.path} depends on`;
  const lines = [
    `${head}${r.depth ? ` — depth ${r.depth}` : ""}`,
    `${r.hits.length} node(s), ${r.files} file(s)`,
  ];
  for (const h of r.hits) {
    const ev = h.via.evidence;
    const at = ev?.file
      ? ` ${ev.file}:${ev.startLine ?? "?"}${ev.kind === "unresolved" ? " (unresolved)" : ""}`
      : "";
    lines.push(`  ${"  ".repeat(h.distance - 1)}${h.path}  [${h.kind}]${at}`);
  }
  if (!r.hits.length)
    lines.push(
      `  nothing ${what} it (static analysis only; dynamic imports and runtime wiring are not visible)`,
    );
  return lines.join("\n");
}
