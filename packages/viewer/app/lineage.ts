import type { GraphView } from "@buildrax/graph";

export type Role = "self" | "upstream" | "downstream";

export interface Lineage {
  roles: Map<string, Role>;
  edges: Map<string, "upstream" | "downstream">;
}

/** Upstream/downstream reachability over the *visible* graph. depth 0 = unlimited. */
export function computeLineage(view: GraphView, start: string, depth: number): Lineage {
  const limit = depth > 0 ? depth : Infinity;
  const roles = new Map<string, Role>([[start, "self"]]);
  const edges = new Map<string, "upstream" | "downstream">();

  const walk = (dir: "downstream" | "upstream"): void => {
    const seen = new Set([start]);
    let frontier = [start];
    for (let d = 0; d < limit && frontier.length; d++) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const e of view.edges) {
          const from = dir === "downstream" ? e.from : e.to;
          const to = dir === "downstream" ? e.to : e.from;
          if (from !== id) continue;
          if (!edges.has(e.id)) edges.set(e.id, dir);
          if (!seen.has(to)) {
            seen.add(to);
            next.push(to);
            if (!roles.has(to)) roles.set(to, dir);
          }
        }
      }
      frontier = next;
    }
  };
  walk("downstream");
  walk("upstream");
  return { roles, edges };
}
