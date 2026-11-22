import ElkBundled from "elkjs/lib/elk.bundled.js";
import type { ELK as ElkApi, ElkExtendedEdge, ElkNode } from "elkjs/lib/elk-api.js";
import type { GraphView } from "@buildrax/graph";
import type { Pt } from "./geometry.js";
import type { Groups } from "./groups.js";

const elk = new (ElkBundled as unknown as new () => ElkApi)();

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface BlueprintLayout {
  /** Card rectangles in absolute coordinates. */
  cards: Map<string, Box>;
  /** Orthogonal arrow routes (absolute): start, bend points, end. */
  routes: Map<string, Pt[]>;
  /** Group frames (segments) by group id. */
  frames: Map<string, Box>;
}

export const CARD_H = 58;

/** Card width from its title (bounded), so long file names stay readable. */
export function cardWidth(name: string): number {
  return Math.round(Math.min(280, Math.max(150, name.length * 7.6 + 70)));
}

const FRAME = "frame:";

/** Room a frame header needs: uppercase bold title, caption and collapse button. */
export function frameMinWidth(label: string, sub: string, collapsible: boolean): number {
  return Math.round(label.length * 9 + sub.length * 6.5 + (collapsible ? 70 : 40));
}

/**
 * Structured "blueprint" layout for the Node view: rectangular cards in left-to-right layers,
 * segments as frames (ELK compound nodes) and orthogonal arrow routes computed by ELK. Routes of
 * arrows inside frames are reported by ELK relative to their container; they are converted here.
 */
export async function blueprintLayout(view: GraphView, groups?: Groups): Promise<BlueprintLayout> {
  const frames = new Map<string, ElkNode>();
  for (const g of groups?.specs ?? []) {
    frames.set(g.id, {
      id: FRAME + g.id,
      children: [],
      layoutOptions: {
        "elk.padding": "[top=46,left=22,bottom=22,right=22]",
        // Never narrower than its header, so the title and caption always fit.
        "elk.nodeSize.constraints": "[MINIMUM_SIZE]",
        "elk.nodeSize.minimum": `(${frameMinWidth(g.label, g.sub, !!g.collapseId)}, 80)`,
      },
    });
  }
  const root: ElkNode = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.hierarchyHandling": "INCLUDE_CHILDREN",
      "elk.partitioning.activate": "true",
      "elk.layered.spacing.nodeNodeBetweenLayers": "64",
      "elk.spacing.nodeNode": "22",
      "elk.layered.spacing.edgeNodeBetweenLayers": "22",
      "elk.spacing.edgeEdge": "10",
      "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
    },
    children: [],
    edges: view.edges.map((e): ElkExtendedEdge => ({
      id: e.id,
      sources: [e.from],
      targets: [e.to],
    })),
  };
  for (const g of groups?.specs ?? []) {
    const el = frames.get(g.id)!;
    const parent = g.parent ? frames.get(g.parent) : undefined;
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
    const parent = groups?.groupOf.get(n.id);
    const frame = parent ? frames.get(parent) : undefined;
    const leaf: ElkNode = { id: n.id, width: cardWidth(n.name), height: CARD_H };
    if (frame) (frame.children ??= []).push(leaf);
    else {
      leaf.layoutOptions = {
        "elk.partitioning.partition": n.kind === "external" || n.kind === "unresolved" ? "1" : "0",
      };
      root.children!.push(leaf);
    }
  }

  const out = await elk.layout(root);
  const abs = new Map<string, Box>([
    ["root", { x: 0, y: 0, w: out.width ?? 0, h: out.height ?? 0 }],
  ]);
  const result: BlueprintLayout = { cards: new Map(), routes: new Map(), frames: new Map() };
  const edges: ElkExtendedEdge[] = [...(out.edges ?? [])];
  const walk = (node: ElkNode, ox: number, oy: number): void => {
    for (const c of node.children ?? []) {
      const box = { x: ox + (c.x ?? 0), y: oy + (c.y ?? 0), w: c.width ?? 0, h: c.height ?? 0 };
      abs.set(c.id, box);
      if (c.id.startsWith(FRAME)) result.frames.set(c.id.slice(FRAME.length), box);
      else result.cards.set(c.id, box);
      edges.push(...(c.edges ?? []));
      walk(c, box.x, box.y);
    }
  };
  walk(out, 0, 0);
  for (const e of edges) {
    const s = e.sections?.[0];
    if (!s) continue;
    const container = (e as ElkExtendedEdge & { container?: string }).container ?? "root";
    const off = abs.get(container) ?? { x: 0, y: 0 };
    const shift = (p: Pt): Pt => ({ x: p.x + off.x, y: p.y + off.y });
    result.routes.set(e.id, [
      shift(s.startPoint),
      ...(s.bendPoints ?? []).map(shift),
      shift(s.endPoint),
    ]);
  }
  return result;
}
