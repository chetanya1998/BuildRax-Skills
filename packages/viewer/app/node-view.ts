import type { GraphView } from "@buildrax/graph";
import type { Pt } from "./geometry.js";
import type { Lineage } from "./lineage.js";

/** Only the focused node and its upstream/downstream neighbourhood (as found by the lineage). */
export function focusView(view: GraphView, lineage: Lineage): GraphView {
  const keep = new Set(lineage.roles.keys());
  return {
    nodes: view.nodes.filter((n) => keep.has(n.id)),
    edges: view.edges.filter((e) => lineage.edges.has(e.id) && keep.has(e.from) && keep.has(e.to)),
  };
}

export const NODE_VIEW_COLUMN_GAP = 270;

/**
 * Node view layout: the focused node in the middle, things that depend on it in columns to the
 * left (one column per hop), things it depends on to the right. Each column is stacked without
 * overlap, using each orb's size plus room for its label.
 */
export function nodeViewLayout(
  view: GraphView,
  lineage: Lineage,
  radii: ReadonlyMap<string, number>,
): Map<string, Pt> {
  const columns = new Map<number, { id: string; name: string; r: number }[]>();
  for (const n of view.nodes) {
    const role = lineage.roles.get(n.id);
    if (!role) continue;
    const d = lineage.dist.get(n.id) ?? 1;
    const col = role === "self" ? 0 : role === "upstream" ? -d : d;
    const list = columns.get(col) ?? [];
    list.push({ id: n.id, name: n.name, r: radii.get(n.id) ?? 16 });
    columns.set(col, list);
  }
  const out = new Map<string, Pt>();
  for (const [col, list] of columns) {
    list.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : 1));
    const heights = list.map((n) => 2 * n.r + 48);
    const total = heights.reduce((t, h) => t + h, 0);
    let y = -total / 2;
    list.forEach((n, i) => {
      out.set(n.id, { x: col * NODE_VIEW_COLUMN_GAP, y: y + heights[i]! / 2 });
      y += heights[i]!;
    });
  }
  return out;
}
