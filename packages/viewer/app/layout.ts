import ElkBundled from "elkjs/lib/elk.bundled.js";
import type { ELK as ElkApi, ElkNode } from "elkjs/lib/elk-api.js";
import type { GraphView } from "@buildrax/graph";
import { nodeBox, type Pt } from "./geometry.js";
import type { Groups } from "./groups.js";

// The package ships ESM-style typings for a CJS bundle; cast to its constructor shape.
const elk = new (ElkBundled as unknown as new () => ElkApi)();

/**
 * Layered left-to-right layout. With `groups`, each box becomes an ELK compound node so members
 * stay together and sibling boxes do not overlap. Returns the center of each orb (links are drawn
 * by the scene as curves, so ELK's routes are not used). Externals sit in a later partition.
 */
export async function layoutView(
  view: GraphView,
  radii: ReadonlyMap<string, number>,
  groups?: Groups,
): Promise<Map<string, Pt>> {
  const boxes = new Map<string, { w: number; h: number; r: number }>();
  const leaf = (id: string, name: string, kind: string, top: boolean): ElkNode => {
    const r = radii.get(id) ?? 16;
    const box = nodeBox(r, name);
    boxes.set(id, { ...box, r });
    return {
      id,
      width: box.w,
      height: box.h,
      layoutOptions: top
        ? { "elk.partitioning.partition": kind === "external" || kind === "unresolved" ? "1" : "0" }
        : {},
    };
  };

  const compound = new Map<string, ElkNode>();
  const specs = groups?.specs ?? [];
  for (const g of specs) {
    compound.set(g.id, {
      id: `box:${g.id}`,
      children: [],
      layoutOptions: { "elk.padding": "[top=50,left=26,bottom=34,right=26]" },
    });
  }
  const root: ElkNode = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.partitioning.activate": "true",
      "elk.hierarchyHandling": "INCLUDE_CHILDREN",
      "elk.layered.spacing.nodeNodeBetweenLayers": "80",
      "elk.spacing.nodeNode": "26",
      "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
    },
    children: [],
    edges: view.edges.map((e) => ({ id: e.id, sources: [e.from], targets: [e.to] })),
  };

  // Boxes first (nested under their parent box, or the root), then the orbs in their innermost box.
  for (const g of specs) {
    const el = compound.get(g.id)!;
    const parent = g.parent ? compound.get(g.parent) : undefined;
    if (parent) (parent.children ??= []).push(el);
    else {
      el.layoutOptions = {
        ...el.layoutOptions,
        "elk.partitioning.partition": g.kind === "container" ? "0" : "1",
      };
      root.children!.push(el);
    }
  }
  for (const n of view.nodes) {
    const gid = groups?.groupOf.get(n.id);
    const parent = gid ? compound.get(gid) : undefined;
    const el = leaf(n.id, n.name, n.kind, !parent);
    if (parent) (parent.children ??= []).push(el);
    else root.children!.push(el);
  }

  const out = await elk.layout(root);
  const centers = new Map<string, Pt>();
  const walk = (node: ElkNode, ox: number, oy: number): void => {
    for (const c of node.children ?? []) {
      const x = ox + (c.x ?? 0);
      const y = oy + (c.y ?? 0);
      const b = boxes.get(c.id);
      if (b) centers.set(c.id, { x: x + b.w / 2, y: y + b.r + 4 });
      else walk(c, x, y);
    }
  };
  walk(out, 0, 0);
  return centers;
}
