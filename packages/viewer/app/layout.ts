import ElkBundled from "elkjs/lib/elk.bundled.js";
import type { ELK as ElkApi, ElkNode } from "elkjs/lib/elk-api.js";
import type { GraphView } from "@buildrax/graph";
import { nodeBox, type Pt } from "./geometry.js";

// The package ships ESM-style typings for a CJS bundle; cast to its constructor shape.
const elk = new (ElkBundled as unknown as new () => ElkApi)();

/**
 * Layered left-to-right layout. Returns the center of each orb (edges are drawn by the scene as
 * curves, so ELK's routes are not used). External/unresolved targets sit in a later partition.
 */
export async function layoutView(
  view: GraphView,
  radii: ReadonlyMap<string, number>,
): Promise<Map<string, Pt>> {
  const boxes = new Map<string, { w: number; h: number; r: number }>();
  const children = view.nodes.map((n) => {
    const r = radii.get(n.id) ?? 16;
    const box = nodeBox(r, n.name);
    boxes.set(n.id, { ...box, r });
    return {
      id: n.id,
      width: box.w,
      height: box.h,
      layoutOptions: {
        "elk.partitioning.partition": n.kind === "external" || n.kind === "unresolved" ? "1" : "0",
      },
    };
  });
  const graph: ElkNode = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.partitioning.activate": "true",
      "elk.layered.spacing.nodeNodeBetweenLayers": "90",
      "elk.spacing.nodeNode": "26",
      "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
    },
    children,
    edges: view.edges.map((e) => ({ id: e.id, sources: [e.from], targets: [e.to] })),
  };
  const out = await elk.layout(graph);
  const centers = new Map<string, Pt>();
  for (const c of out.children ?? []) {
    const b = boxes.get(c.id)!;
    centers.set(c.id, { x: (c.x ?? 0) + b.w / 2, y: (c.y ?? 0) + b.r + 4 });
  }
  return centers;
}
