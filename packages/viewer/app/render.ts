import type { GraphView, ViewEdge, ViewNode } from "@buildrax/graph";
import { s } from "./dom.js";
import type { Layout } from "./layout.js";
import type { Lineage } from "./lineage.js";

export interface RenderCtx {
  selected?: { type: "node" | "edge"; id: string };
  lineage?: Lineage;
}

const KIND_LABEL: Record<string, string> = {
  module: "MODULE",
  file: "FILE",
  external: "EXTERNAL",
  unresolved: "UNRESOLVED",
  project: "PROJECT",
};

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`;
}

function edgePath(points: { x: number; y: number }[]): string {
  return points.map((p, i) => `${i ? "L" : "M"}${p.x},${p.y}`).join(" ");
}

export function defs(): SVGDefsElement {
  const marker = (id: string, cls: string): SVGMarkerElement =>
    s(
      "marker",
      {
        id,
        viewBox: "0 0 10 10",
        refX: 9,
        refY: 5,
        markerWidth: 7,
        markerHeight: 7,
        orient: "auto-start-reverse",
      },
      s("path", { d: "M0,0 L10,5 L0,10 z", class: cls }),
    );
  return s(
    "defs",
    null,
    s(
      "pattern",
      { id: "grid-minor", width: 8, height: 8, patternUnits: "userSpaceOnUse" },
      s("path", { d: "M8,0 L0,0 0,8", class: "grid-minor" }),
    ),
    s(
      "pattern",
      { id: "grid-major", width: 40, height: 40, patternUnits: "userSpaceOnUse" },
      s("rect", { width: 40, height: 40, fill: "url(#grid-minor)" }),
      s("path", { d: "M40,0 L0,0 0,40", class: "grid-major" }),
    ),
    marker("arrow", "arrow"),
    marker("arrow-up", "arrow up"),
    marker("arrow-down", "arrow down"),
    marker("arrow-cycle", "arrow cycle"),
  );
}

export function gridRect(): SVGRectElement {
  return s("rect", {
    x: -20000,
    y: -20000,
    width: 40000,
    height: 40000,
    fill: "url(#grid-major)",
    class: "grid",
  });
}

function renderEdge(e: ViewEdge, layout: Layout): SVGGElement | null {
  const le = layout.edges.get(e.id);
  if (!le || le.points.length < 2) return null;
  const mid = le.points[Math.floor(le.points.length / 2)]!;
  const g = s(
    "g",
    {
      class: `edge${e.inCycle ? " cycle" : ""}`,
      "data-edge": e.id,
      "data-mx": mid.x,
      "data-my": mid.y,
    },
    s("path", { d: edgePath(le.points), class: "hit" }),
    s("path", {
      d: edgePath(le.points),
      class: "line",
      "marker-end": `url(#${e.inCycle ? "arrow-cycle" : "arrow"})`,
    }),
  );
  if (e.count > 1)
    g.append(s("text", { x: mid.x, y: mid.y - 4, class: "edge-count" }, String(e.count)));
  return g;
}

function renderNode(n: ViewNode, layout: Layout): SVGGElement | null {
  const l = layout.nodes.get(n.id);
  if (!l) return null;
  const sub = n.expandable
    ? `${n.fileCount} file${n.fileCount === 1 ? "" : "s"} · double-click`
    : (KIND_LABEL[n.kind] ?? n.kind);
  const t = 6;
  const g = s(
    "g",
    {
      class: `node kind-${n.kind}${n.inCycle ? " cycle" : ""}`,
      transform: `translate(${l.x},${l.y})`,
      "data-node": n.id,
      tabindex: 0,
      role: "button",
      "aria-label": `${n.kind} ${n.name}`,
    },
    s("rect", { class: "box", width: l.w, height: l.h, rx: 2 }),
    s("path", {
      class: "tick",
      d: `M0,${t} L0,0 L${t},0 M${l.w - t},0 L${l.w},0 L${l.w},${t} M${l.w},${l.h - t} L${l.w},${l.h} L${l.w - t},${l.h} M${t},${l.h} L0,${l.h} L0,${l.h - t}`,
    }),
    s("text", { class: "label", x: 12, y: 22 }, truncate(n.name, Math.floor((l.w - 24) / 7.4))),
    s("text", { class: "sub", x: 12, y: 40 }, sub),
  );
  g.append(s("title", null, `${n.kind}: ${n.name}`));
  return g;
}

/** Build the node/edge layers once per layout. Selection changes only toggle classes (see paint). */
export function renderGraph(layer: SVGGElement, view: GraphView, layout: Layout): void {
  layer.replaceChildren();
  const edgeLayer = s("g", { class: "edges" });
  const nodeLayer = s("g", { class: "nodes" });
  for (const e of view.edges) {
    const el = renderEdge(e, layout);
    if (el) edgeLayer.append(el);
  }
  for (const n of view.nodes) {
    const el = renderNode(n, layout);
    if (el) nodeLayer.append(el);
  }
  layer.append(edgeLayer, nodeLayer);
}

/** Update highlight classes in place so the DOM (and in-flight clicks) stay stable. */
export function paintHighlight(layer: SVGGElement, ctx: RenderCtx): void {
  const { lineage, selected } = ctx;
  layer.querySelectorAll<SVGGElement>("[data-node]").forEach((el) => {
    const id = el.getAttribute("data-node")!;
    const role = lineage?.roles.get(id);
    el.classList.toggle("dim", !!lineage && !role);
    el.classList.toggle("upstream", role === "upstream");
    el.classList.toggle("downstream", role === "downstream");
    el.classList.toggle("selected", selected?.id === id);
  });
  layer.querySelectorAll<SVGGElement>("[data-edge]").forEach((el) => {
    const id = el.getAttribute("data-edge")!;
    const dir = lineage?.edges.get(id);
    el.classList.toggle("dim", !!lineage && !dir);
    el.classList.toggle("upstream", dir === "upstream");
    el.classList.toggle("downstream", dir === "downstream");
    el.classList.toggle("selected", selected?.id === id);
    const cyc = el.classList.contains("cycle");
    const marker = cyc
      ? "arrow-cycle"
      : dir === "upstream"
        ? "arrow-up"
        : dir === "downstream"
          ? "arrow-down"
          : "arrow";
    el.querySelector(".line")?.setAttribute("marker-end", `url(#${marker})`);
  });
}
