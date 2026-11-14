import ElkBundled from "elkjs/lib/elk.bundled.js";
import type { ELK as ElkApi, ElkNode } from "elkjs/lib/elk-api.js";
import type { GraphView } from "@buildrax/graph";

export interface LNode {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface LEdge {
  id: string;
  points: { x: number; y: number }[];
}
export interface Layout {
  nodes: Map<string, LNode>;
  edges: Map<string, LEdge>;
  width: number;
  height: number;
}

export function nodeSize(name: string): { w: number; h: number } {
  return { w: Math.max(130, Math.min(260, Math.round(name.length * 7.4 + 36))), h: 52 };
}

// The package ships ESM-style typings for a CJS bundle; cast to its constructor shape.
const elk = new (ElkBundled as unknown as new () => ElkApi)();

/** Layered left-to-right layout. External/unresolved targets sit in a later partition (right). */
export async function layoutView(view: GraphView): Promise<Layout> {
  const children = view.nodes.map((n) => {
    const { w, h } = nodeSize(n.name);
    return {
      id: n.id,
      width: w,
      height: h,
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
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.partitioning.activate": "true",
      "elk.layered.spacing.nodeNodeBetweenLayers": "80",
      "elk.spacing.nodeNode": "28",
      "elk.spacing.edgeNode": "20",
    },
    children,
    edges: view.edges.map((e) => ({ id: e.id, sources: [e.from], targets: [e.to] })),
  };
  const out = await elk.layout(graph);
  const nodes = new Map<string, LNode>();
  for (const c of out.children ?? []) {
    nodes.set(c.id, { id: c.id, x: c.x ?? 0, y: c.y ?? 0, w: c.width ?? 0, h: c.height ?? 0 });
  }
  const edges = new Map<string, LEdge>();
  for (const e of out.edges ?? []) {
    const sec = e.sections?.[0];
    if (!sec) continue;
    edges.set(e.id, {
      id: e.id,
      points: [sec.startPoint, ...(sec.bendPoints ?? []), sec.endPoint],
    });
  }
  return { nodes, edges, width: out.width ?? 0, height: out.height ?? 0 };
}
