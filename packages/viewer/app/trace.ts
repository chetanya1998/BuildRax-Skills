import type { GraphView, ViewEdge } from "@buildrax/graph";
import type { Evidence } from "@buildrax/ir";
import type { Lineage, Role } from "./lineage.js";

export type TraceDirection = "both" | "downstream" | "upstream";

export interface TraceLink {
  edgeId: string;
  from: string;
  to: string;
  /** First source anchor for the link, when known. */
  evidence?: Evidence;
  count: number;
}

export interface TraceStep {
  /** 1-based hop number. */
  n: number;
  direction: "downstream" | "upstream";
  links: TraceLink[];
}

const byId = (a: { edgeId: string }, b: { edgeId: string }): number =>
  a.edgeId < b.edgeId ? -1 : a.edgeId > b.edgeId ? 1 : 0;

/**
 * Turn a lineage into ordered steps: hop 1, hop 2, ... in each direction. A downstream step links
 * a node at hop n-1 to one at hop n ("uses"); an upstream step links a node at hop n to one at
 * hop n-1 ("is used by"). Deterministic order, so the walkthrough never shuffles.
 */
export function buildTrace(
  view: GraphView,
  lineage: Lineage,
  direction: TraceDirection = "both",
): TraceStep[] {
  const edges = new Map(view.edges.map((e) => [e.id, e] as const));
  const steps = new Map<string, TraceStep>();
  for (const [edgeId, dir] of lineage.edges) {
    if (direction !== "both" && dir !== direction) continue;
    const e = edges.get(edgeId);
    if (!e) continue;
    // The hop number is the distance of the end that is further from the selection.
    const far = dir === "downstream" ? e.to : e.from;
    const near = dir === "downstream" ? e.from : e.to;
    const n = lineage.dist.get(far);
    const nearDist = lineage.dist.get(near);
    if (n === undefined || nearDist === undefined || n !== nearDist + 1) continue; // skip back-edges in cycles
    if (lineage.roles.get(far) !== dir) continue;
    const key = `${dir}:${n}`;
    const step = steps.get(key) ?? { n, direction: dir, links: [] };
    step.links.push(link(e));
    steps.set(key, step);
  }
  const out = [...steps.values()];
  for (const s of out) s.links.sort(byId);
  // Downstream first (what it uses), then upstream (what uses it); each by hop.
  return out.sort((a, b) =>
    a.direction === b.direction ? a.n - b.n : a.direction === "downstream" ? -1 : 1,
  );
}

function link(e: ViewEdge): TraceLink {
  return { edgeId: e.id, from: e.from, to: e.to, evidence: e.evidence[0], count: e.count };
}

/**
 * Narrow a lineage to what the user is looking at: one direction, and/or only the first `upTo`
 * hops (0 = all). Used to play the trace step by step on both views.
 */
export function limitLineage(lineage: Lineage, direction: TraceDirection, upTo: number): Lineage {
  const keepRole = (r: Role | undefined): boolean =>
    r === "self" || direction === "both" || r === direction;
  const within = (id: string): boolean => upTo <= 0 || (lineage.dist.get(id) ?? Infinity) <= upTo;
  const roles = new Map([...lineage.roles].filter(([id, r]) => keepRole(r) && within(id)));
  const dist = new Map([...lineage.dist].filter(([id]) => roles.has(id)));
  const edges = new Map(
    [...lineage.edges].filter(([, dir]) => direction === "both" || dir === direction),
  );
  return { roles, dist, edges: new Map([...edges].filter(([id]) => edgeEndsKept(id, roles))) };
}

/** Step number shown on each edge (its hop), for the numbered arrows. */
export function stepNumbers(
  steps: readonly TraceStep[],
): Map<string, { n: number; direction: "downstream" | "upstream" }> {
  const out = new Map<string, { n: number; direction: "downstream" | "upstream" }>();
  for (const s of steps)
    for (const l of s.links) out.set(l.edgeId, { n: s.n, direction: s.direction });
  return out;
}

function edgeEndsKept(edgeId: string, roles: Map<string, Role>): boolean {
  const [from, to] = edgeId.split("=>");
  return !!from && !!to && roles.has(from) && roles.has(to);
}
