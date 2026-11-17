import type { GraphView, ViewEdge, ViewNode } from "@buildrax/graph";
import { s } from "./dom.js";
import { easeInOutCubic, edgeGeometry, quadAt, type Pt } from "./geometry.js";
import type { Lineage } from "./lineage.js";
import type { Badge } from "./notes-logic.js";
import { groupPath, type GroupSpec } from "./groups.js";
import { boxRects, ForceSim, type SimNode } from "./physics.js";

export type LayoutMode = "layered" | "force";

export interface NodeStyle {
  hue: number;
  sat: number;
  /** Color-group key (legend entry); used to focus one color. */
  key: string;
  r: number;
  /** Innermost segmentation box the node sits in. */
  group?: string;
}

export interface SceneGraph {
  view: GraphView;
  mode: LayoutMode;
  /** Orb centers from the layered layout. */
  positions: Map<string, Pt>;
  style: Map<string, NodeStyle>;
  /** Ancestors of a node, nearest first (to animate expand/collapse). */
  ancestors(id: string): string[];
  /** Segmentation boxes (nested); empty when segments are off. */
  groups: GroupSpec[];
  cluster: boolean;
}

export interface Selection {
  type: "node" | "edge";
  id: string;
}

export interface Highlight {
  selected?: Selection;
  lineage?: Lineage;
  /** Dim everything whose color key differs (legend focus). */
  focusKey?: string;
}

export interface SceneEvents {
  select(sel: Selection | undefined): void;
  expand(id: string): void;
  /** Collapse an expanded container (its box's header button). */
  collapse(id: string): void;
}

interface SNode {
  id: string;
  view: ViewNode;
  style: NodeStyle;
  x: number;
  y: number;
  tx: number;
  ty: number;
  scale: number;
  targetScale: number;
  exiting: boolean;
  pinned: boolean;
  el: SVGGElement;
  body: SVGGElement;
  badge?: SVGGElement;
}

interface SEdge {
  view: ViewEdge;
  side: 1 | -1;
  el: SVGGElement;
  line: SVGPathElement;
  hit: SVGPathElement;
  arrow: SVGPathElement;
  count?: SVGTextElement;
  badge?: SVGGElement;
  mid: Pt;
  start: Pt;
  ctrl: Pt;
  end: Pt;
}

interface GBox {
  spec: GroupSpec;
  el: SVGGElement;
  rect: SVGRectElement;
  tab: SVGGElement;
  tabBg: SVGRectElement;
  collapse?: SVGGElement;
  /** Nodes directly inside this box, and boxes nested in it. */
  nodes: string[];
  children: string[];
  tabW: number;
  /** Path key used by the physics' box rectangles. */
  key: string;
}

const ICONS: Record<string, string> = {
  module: "M0,-7 L6,-3.5 L6,3.5 L0,7 L-6,3.5 L-6,-3.5 Z M0,0 L0,7 M0,0 L6,-3.5 M0,0 L-6,-3.5",
  project: "M-6,-2 L0,-7 L6,-2 L6,6 L-6,6 Z M-2,6 L-2,1 L2,1 L2,6",
  file: "M-4,-6 L2,-6 L5,-3 L5,6 L-4,6 Z M2,-6 L2,-3 L5,-3 M-2,0 L3,0 M-2,3 L3,3",
  external: "M-6,0 A6,6 0 1 0 6,0 A6,6 0 1 0 -6,0 M-6,0 L6,0 M0,-6 Q-4,0 0,6 M0,-6 Q4,0 0,6",
  unresolved: "M-3,-3 Q-3,-6 0,-6 Q3,-6 3,-3 Q3,-1 0,1 L0,3 M0,6 L0,6.5",
};

const hash = (str: string): number => {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return h >>> 0;
};

/** Space a node needs (orb plus its label), shared by the physics and the box drawing. */
const extentR = (r: number, name: string): number =>
  Math.max(r + 19, Math.min(110, name.length * 3.6 + 8));

const truncate = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`;

/**
 * Owns the SVG: animated orbs and edges, live physics, dragging, camera, code-segmentation boxes, flow
 * particles and the minimap. It knows nothing about the architecture model beyond what it is given.
 */
export class Scene {
  private readonly viewport = s("g", { id: "viewport" });
  private readonly boxLayer = s("g", { class: "boxes" });
  private readonly edgeLayer = s("g", { class: "edges" });
  private readonly particleLayer = s("g", { class: "particles" });
  private readonly nodeLayer = s("g", { class: "nodes" });

  private nodes = new Map<string, SNode>();
  private edges: SEdge[] = [];
  private boxes: GBox[] = [];
  private particles: { el: SVGCircleElement; edge: SEdge; phase: number }[] = [];
  private adjacency = new Map<string, Set<string>>();
  private mode: LayoutMode = "layered";
  private sim: ForceSim | undefined;
  private graph: SceneGraph | undefined;

  private tf = { x: 0, y: 0, k: 1 };
  private cam:
    | {
        from: { x: number; y: number; k: number };
        to: { x: number; y: number; k: number };
        t0: number;
        dur: number;
      }
    | undefined;
  private fitWhenSettled = false;
  private lastAutoFit = 0;

  private highlight: Highlight = {};
  private hover: string | undefined;
  private nodeBadges = new Map<string, Badge>();
  private edgeBadges = new Map<string, Badge>();

  private motion: boolean;
  private raf = 0;
  private last = 0;
  private suppressClick = false;
  private minimap: HTMLCanvasElement | undefined;

  constructor(
    readonly svg: SVGSVGElement,
    private readonly events: SceneEvents,
  ) {
    this.motion = !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    svg.append(this.defs(), this.viewport);
    this.viewport.append(
      s("rect", {
        x: -20000,
        y: -20000,
        width: 40000,
        height: 40000,
        fill: "url(#grid-major)",
        class: "grid",
      }),
      this.boxLayer,
      this.edgeLayer,
      this.particleLayer,
      this.nodeLayer,
    );
    this.bindEvents();
    // When panels open, close or float, keep whatever was in the middle of the canvas in the middle
    // instead of re-zooming, so the user does not lose their place.
    let last = { w: 0, h: 0 };
    new ResizeObserver(() => {
      const r = svg.getBoundingClientRect();
      if (last.w && last.h && (r.width !== last.w || r.height !== last.h)) {
        this.cam = undefined;
        this.tf.x += (r.width - last.w) / 2;
        this.tf.y += (r.height - last.h) / 2;
        this.applyCamera();
        this.drawMinimap();
      }
      last = { w: r.width, h: r.height };
    }).observe(svg);
  }

  // ---------------------------------------------------------------- public API

  get motionEnabled(): boolean {
    return this.motion;
  }

  setMotion(on: boolean): void {
    this.motion = on;
    document.body.classList.toggle("no-motion", !on);
    if (this.highlight.lineage) this.rebuildParticles();
    this.wake();
  }

  get layoutMode(): LayoutMode {
    return this.mode;
  }

  /** Replace the graph. Existing nodes keep their place and glide to new targets; new ones burst out of their parent. */
  setGraph(g: SceneGraph, opts: { fit?: boolean } = {}): void {
    const prev = this.nodes;
    const first = prev.size === 0;
    this.graph = g;
    this.mode = g.mode;
    const next = new Map<string, SNode>();
    const ids = new Set(g.view.nodes.map((n) => n.id));

    const centroid = [...g.positions.values()].reduce(
      (c, p, _i, a) => ({ x: c.x + p.x / a.length, y: c.y + p.y / a.length }),
      { x: 0, y: 0 },
    );

    for (const vn of g.view.nodes) {
      const style = g.style.get(vn.id) ?? { hue: 215, sat: 30, key: "?", r: 16 };
      const target = g.positions.get(vn.id);
      let n = prev.get(vn.id);
      if (n && !n.exiting) {
        n.view = vn;
        n.style = style;
        this.refreshNodeEl(n);
      } else {
        const from = this.spawnPoint(vn.id, prev, g, first ? centroid : undefined);
        n = this.createNode(vn, style, from);
        n.scale = 0;
      }
      n.exiting = false;
      n.targetScale = 1;
      if (g.mode === "layered" && target) {
        n.tx = target.x;
        n.ty = target.y;
      } else {
        n.tx = n.x;
        n.ty = n.y;
      }
      next.set(vn.id, n);
    }

    // Nodes that left the view fly into whatever replaced them, shrinking away.
    for (const [id, old] of prev) {
      if (ids.has(id)) continue;
      old.exiting = true;
      old.targetScale = 0;
      const inside = g.view.nodes.filter((v) => g.ancestors(v.id).includes(id));
      let dest: Pt | undefined;
      if (inside.length) {
        dest = {
          x: inside.reduce((t, v) => t + (next.get(v.id)?.tx ?? old.x), 0) / inside.length,
          y: inside.reduce((t, v) => t + (next.get(v.id)?.ty ?? old.y), 0) / inside.length,
        };
      } else {
        const anc = g.ancestors(id).find((a) => next.has(a));
        if (anc) dest = { x: next.get(anc)!.tx, y: next.get(anc)!.ty };
      }
      old.tx = dest?.x ?? old.x;
      old.ty = dest?.y ?? old.y;
      next.set(id, old);
    }
    this.nodes = next;
    this.rebuildEdges(g);
    this.rebuildBoxes(g);
    this.startSim(g);
    this.applyHighlight();
    this.applyBadges();
    this.fitWhenSettled = !!opts.fit;
    if (!this.motion) this.snap();
    this.wake();
    if (opts.fit && g.mode === "layered") this.fit(this.motion && !first);
  }

  setHighlight(h: Highlight): void {
    const prevSel = this.highlight.selected;
    this.highlight = h;
    this.applyHighlight();
    this.rebuildParticles();
    if (h.selected?.type === "node" && (prevSel?.id !== h.selected.id || prevSel.type !== "node"))
      this.ripple(h.selected.id);
    this.wake();
  }

  setBadges(nodes: Map<string, Badge>, edges: Map<string, Badge>): void {
    this.nodeBadges = nodes;
    this.edgeBadges = edges;
    this.applyBadges();
    this.wake();
  }

  /** Update colors/sizes only (no relayout). */
  restyle(style: Map<string, NodeStyle>): void {
    for (const n of this.nodes.values()) {
      const st = style.get(n.id);
      if (st) {
        n.style = st;
        this.refreshNodeEl(n);
      }
    }
    if (this.graph) {
      this.graph = { ...this.graph, style };
    }
    this.applyHighlight();
    this.wake();
  }

  reheat(): void {
    if (this.mode !== "force" || !this.sim) return;
    this.sim.reheat(0.9);
    this.wake();
  }

  unpinAll(): void {
    for (const n of this.nodes.values()) {
      n.pinned = false;
      n.el.classList.remove("pinned");
      const sn = this.sim?.node(n.id);
      if (sn) sn.pinned = false;
    }
    this.reheat();
  }

  nodePosition(id: string): Pt | undefined {
    const n = this.nodes.get(id);
    return n ? { x: n.x, y: n.y } : undefined;
  }

  fit(animate = true): void {
    const b = this.bounds();
    const r = this.svg.getBoundingClientRect();
    if (!b || !r.width || !r.height) return;
    const w = Math.max(1, b.maxX - b.minX);
    const h = Math.max(1, b.maxY - b.minY);
    const k = Math.min((r.width - 120) / w, (r.height - 120) / h, 1.35);
    const kk = Math.max(0.12, k);
    this.cameraTo(
      { k: kk, x: (r.width - w * kk) / 2 - b.minX * kk, y: (r.height - h * kk) / 2 - b.minY * kk },
      animate,
    );
  }

  centerOn(id: string, animate = true): void {
    const n = this.nodes.get(id);
    const r = this.svg.getBoundingClientRect();
    if (!n || !r.width) return;
    const p = this.targetPos(n);
    const k = Math.min(1.6, Math.max(0.7, this.tf.k));
    this.cameraTo({ k, x: r.width / 2 - p.x * k, y: r.height / 2 - p.y * k }, animate);
  }

  zoomBy(factor: number): void {
    const r = this.svg.getBoundingClientRect();
    this.zoomAt(r.width / 2, r.height / 2, factor);
  }

  /** Redraw the minimap (e.g. after it was shown again). */
  wakeMinimap(): void {
    this.drawMinimap();
  }

  attachMinimap(canvas: HTMLCanvasElement): void {
    this.minimap = canvas;
    canvas.addEventListener("pointerdown", (ev) => {
      const m = this.mapMetrics();
      if (!m) return;
      const rect = canvas.getBoundingClientRect();
      const wx = (ev.clientX - rect.left - m.ox) / m.scale + m.minX;
      const wy = (ev.clientY - rect.top - m.oy) / m.scale + m.minY;
      const r = this.svg.getBoundingClientRect();
      this.cameraTo(
        { k: this.tf.k, x: r.width / 2 - wx * this.tf.k, y: r.height / 2 - wy * this.tf.k },
        true,
      );
    });
  }

  /** Number of visible (non-exiting) nodes. */
  get nodeCount(): number {
    return [...this.nodes.values()].filter((n) => !n.exiting).length;
  }

  // ---------------------------------------------------------------- construction

  private defs(): SVGDefsElement {
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
        { id: "grid-major", width: 48, height: 48, patternUnits: "userSpaceOnUse" },
        s("rect", { width: 48, height: 48, fill: "url(#grid-minor)" }),
        s("path", { d: "M48,0 L0,0 0,48", class: "grid-major" }),
      ),
    );
  }

  private spawnPoint(id: string, prev: Map<string, SNode>, g: SceneGraph, fallback?: Pt): Pt {
    const a = hash(id);
    const jx = ((a % 13) - 6) * 1.2;
    const jy = (((a >> 4) % 13) - 6) * 1.2;
    for (const anc of g.ancestors(id)) {
      const o = prev.get(anc);
      if (o && !o.exiting) return { x: o.x + jx, y: o.y + jy };
    }
    if (fallback) return { x: fallback.x + jx, y: fallback.y + jy };
    const t = g.positions.get(id);
    return { x: (t?.x ?? 0) + jx, y: (t?.y ?? 0) + jy };
  }

  private createNode(vn: ViewNode, style: NodeStyle, at: Pt): SNode {
    const body = s("g", { class: "body" });
    const el = s(
      "g",
      {
        class: "node",
        "data-node": vn.id,
        tabindex: 0,
        role: "button",
        "aria-label": `${vn.kind} ${vn.name}`,
      },
      body,
    );
    const n: SNode = {
      id: vn.id,
      view: vn,
      style,
      x: at.x,
      y: at.y,
      tx: at.x,
      ty: at.y,
      scale: 0,
      targetScale: 1,
      exiting: false,
      pinned: false,
      el,
      body,
    };
    this.refreshNodeEl(n);
    this.nodeLayer.append(el);
    return n;
  }

  /** (Re)draw an orb's contents for its current style and view data. */
  private refreshNodeEl(n: SNode): void {
    const { view: vn, style: st, el, body } = n;
    const r = st.r;
    el.setAttribute(
      "class",
      `node kind-${vn.kind}${vn.inCycle ? " cycle" : ""}${vn.expandable ? " expandable" : ""}${n.pinned ? " pinned" : ""}`,
    );
    el.setAttribute("style", `--h:${st.hue};--s:${st.sat}%`);
    el.setAttribute("aria-label", `${vn.kind} ${vn.name}`);
    const keep = [...body.querySelectorAll(".ripple")];
    const parts: (Element | null)[] = [
      s("circle", { class: "aura", r: r + 12 }),
      vn.expandable ? s("circle", { class: "ring", r: r + 6 }) : null,
      vn.inCycle ? s("circle", { class: "alert", r: r + 9 }) : null,
      s("circle", { class: "orb", r }),
      s("circle", { class: "core", r: r * 0.62 }),
      s("path", {
        class: "shine",
        d: `M${-r * 0.7},${-r * 0.2} A${r * 0.75},${r * 0.75} 0 0 1 ${r * 0.2},${-r * 0.7}`,
      }),
      s("path", {
        class: "icon",
        d: ICONS[vn.kind] ?? ICONS.file!,
        transform: `scale(${Math.max(0.7, Math.min(1.6, r / 14))})`,
      }),
      s("circle", { class: "pin", r: 3.2, cx: r * 0.72, cy: -r * 0.72 }),
      s("text", { class: "label", y: r + 15 }, truncate(vn.name, 26)),
      vn.expandable || vn.kind === "external" || vn.kind === "unresolved"
        ? s(
            "text",
            { class: "sub", y: r + 27 },
            vn.expandable ? `${vn.fileCount} file${vn.fileCount === 1 ? "" : "s"}` : vn.kind,
          )
        : null,
      s("title", null, `${vn.kind}: ${vn.name}${vn.expandable ? " (double-click to expand)" : ""}`),
    ];
    body.replaceChildren(...parts.filter((x): x is Element => x !== null));
    for (const k of keep) body.append(k);
  }

  private rebuildEdges(g: SceneGraph): void {
    this.edgeLayer.replaceChildren();
    this.adjacency = new Map();
    this.edges = [];
    for (const e of g.view.edges) {
      if (!this.nodes.has(e.from) || !this.nodes.has(e.to)) continue;
      const fromStyle = g.style.get(e.from);
      const line = s("path", { class: "line" });
      const hit = s("path", { class: "hit" });
      const arrow = s("path", { class: "arrow", d: "M0,0 L-8,-4 L-6.5,0 L-8,4 Z" });
      const count = e.count > 1 ? s("text", { class: "edge-count" }, String(e.count)) : undefined;
      const el = s(
        "g",
        {
          class: `edge enter${e.inCycle ? " cycle" : ""}`,
          "data-edge": e.id,
          style: `--h:${fromStyle?.hue ?? 215};--s:${fromStyle?.sat ?? 40}%;--w:${(1.1 + Math.min(2.4, Math.log2(e.count))).toFixed(2)}`,
        },
        hit,
        line,
        arrow,
        count ?? null,
      );
      this.edgeLayer.append(el);
      const z = { x: 0, y: 0 };
      this.edges.push({
        view: e,
        side: e.from < e.to ? 1 : -1,
        el,
        line,
        hit,
        arrow,
        count,
        mid: z,
        start: z,
        ctrl: z,
        end: z,
      });
      for (const id of [e.from, e.to]) {
        const set = this.adjacency.get(id) ?? new Set<string>();
        set.add(e.id);
        this.adjacency.set(id, set);
      }
    }
  }

  /** Dotted segmentation boxes: one per expanded container, nested like the code. */
  private rebuildBoxes(g: SceneGraph): void {
    this.boxLayer.replaceChildren();
    this.boxes = [];
    if (!g.cluster) return;
    const byId = new Map<string, GBox>();
    for (const spec of g.groups) {
      const tabW = Math.min(
        300,
        Math.round(spec.label.length * 7.4 + spec.sub.length * 6 + (spec.collapseId ? 62 : 38)),
      );
      const rect = s("rect", { class: "gbox", rx: 20 });
      const tabBg = s("rect", { class: "gtab-bg", height: 24, rx: 12 });
      const tab = s(
        "g",
        { class: "gtab", "data-gtab": spec.id },
        tabBg,
        s("text", { class: "gtitle", x: 12, y: 16 }, spec.label),
        s("text", { class: "gsub", x: 12 + spec.label.length * 7.4 + 8, y: 16 }, spec.sub),
        s(
          "title",
          null,
          spec.collapseId
            ? `${spec.label}: click to inspect, drag to move the whole box`
            : spec.label,
        ),
      );
      let collapse: SVGGElement | undefined;
      if (spec.collapseId) {
        collapse = s(
          "g",
          {
            class: "gcollapse",
            "data-collapse": spec.collapseId,
            role: "button",
            "aria-label": `Collapse ${spec.label}`,
          },
          s("circle", { r: 8 }),
          s("path", { d: "M-3.5,0 L3.5,0" }),
          s("title", null, "Collapse back into one node"),
        );
        tab.append(collapse);
      }
      const el = s(
        "g",
        {
          class: `group depth-${Math.min(spec.depth, 3)} kind-${spec.kind}`,
          style: `--h:${spec.hue}`,
          "data-group": spec.id,
        },
        rect,
        tab,
      );
      this.boxLayer.append(el);
      const box: GBox = {
        spec,
        el,
        rect,
        tab,
        tabBg,
        collapse,
        nodes: [],
        children: [],
        tabW,
        key: groupPath(g.groups, spec.id).join("\u0000"),
      };
      tabBg.setAttribute("width", String(tabW));
      collapse?.setAttribute("transform", `translate(${tabW - 14},12)`);
      byId.set(spec.id, box);
      this.boxes.push(box);
    }
    for (const n of this.nodes.values()) {
      if (n.exiting || !n.style.group) continue;
      byId.get(n.style.group)?.nodes.push(n.id);
    }
    for (const b of this.boxes)
      if (b.spec.parent) byId.get(b.spec.parent)?.children.push(b.spec.id);
  }

  /** Boxes must be at least as wide as their header tab. */
  private boxMinWidth(): Map<string, number> {
    return new Map(this.boxes.map((b) => [b.key, b.tabW + 28]));
  }

  /**
   * Box path for the physics. A node outside every box, or sitting beside nested boxes, counts as
   * its own one-node segment so it is kept clear of the boxes next to it.
   */
  private pathFor(g: SceneGraph, n: SNode): string[] {
    const path = groupPath(g.groups, n.style.group);
    if (!g.cluster) return path;
    const inner = path[path.length - 1];
    const besideBoxes = !inner || g.groups.some((sp) => sp.parent === inner);
    return besideBoxes ? [...path, `free:${n.id}`] : path;
  }

  private startSim(g: SceneGraph): void {
    if (g.mode !== "force") {
      this.sim = undefined;
      return;
    }
    const live = [...this.nodes.values()].filter((n) => !n.exiting);
    const simNodes = live.map((n): SimNode => ({
      id: n.id,
      x: n.x,
      y: n.y,
      vx: 0,
      vy: 0,
      // Orb plus its label, the same extent the boxes are drawn with.
      r: extentR(n.style.r, n.view.name),
      groups: this.pathFor(g, n),
      pinned: n.pinned,
    }));
    this.sim = new ForceSim(
      simNodes,
      g.view.edges.map((e) => ({ a: e.from, b: e.to, weight: e.count })),
      { cluster: g.cluster ? 0.11 : 0, boxMinWidth: this.boxMinWidth() },
    );
    this.sim.alpha = 0.9;
  }

  // ---------------------------------------------------------------- highlight / badges

  private applyHighlight(): void {
    const { lineage, selected, focusKey } = this.highlight;
    for (const n of this.nodes.values()) {
      const role = lineage?.roles.get(n.id);
      const off = (!!lineage && !role) || (!!focusKey && n.style.key !== focusKey);
      n.el.classList.toggle("dim", off);
      n.el.classList.toggle("upstream", role === "upstream");
      n.el.classList.toggle("downstream", role === "downstream");
      n.el.classList.toggle("selected", selected?.type === "node" && selected.id === n.id);
      n.el.classList.toggle("hover", n.id === this.hover);
    }
    if (this.boxes.length) {
      const active = new Set<string>();
      for (const n of this.nodes.values()) {
        if (n.exiting || n.el.classList.contains("dim") || !n.style.group) continue;
        for (const gid of groupPath(this.graph?.groups ?? [], n.style.group)) active.add(gid);
      }
      const filtering = !!lineage || !!focusKey;
      for (const b of this.boxes) b.el.classList.toggle("dim", filtering && !active.has(b.spec.id));
    }
    for (const e of this.edges) {
      const dir = lineage?.edges.get(e.view.id);
      const hot = !!this.hover && (e.view.from === this.hover || e.view.to === this.hover);
      e.el.classList.toggle(
        "dim",
        (!!lineage && !dir && !hot) || (!!focusKey && this.edgeOff(e, focusKey)),
      );
      e.el.classList.toggle("upstream", dir === "upstream");
      e.el.classList.toggle("downstream", dir === "downstream");
      e.el.classList.toggle("hot", hot);
      e.el.classList.toggle("selected", selected?.type === "edge" && selected.id === e.view.id);
    }
  }

  private edgeOff(e: SEdge, key: string): boolean {
    return (
      this.nodes.get(e.view.from)?.style.key !== key && this.nodes.get(e.view.to)?.style.key !== key
    );
  }

  private applyBadges(): void {
    const badge = (b: Badge): SVGGElement =>
      s(
        "g",
        { class: `note-badge dot-${b.color}` },
        s("circle", { r: 9 }),
        s("text", { y: 3.5 }, String(b.count)),
      );
    for (const n of this.nodes.values()) {
      n.badge?.remove();
      n.badge = undefined;
      const b = this.nodeBadges.get(n.id);
      if (b) {
        n.badge = badge(b);
        n.badge.setAttribute("transform", `translate(${n.style.r * 0.78},${-n.style.r * 0.78})`);
        n.el.append(n.badge);
      }
    }
    for (const e of this.edges) {
      e.badge?.remove();
      e.badge = undefined;
      const b = this.edgeBadges.get(e.view.id);
      if (b) {
        e.badge = badge(b);
        e.el.append(e.badge);
      }
    }
  }

  private rebuildParticles(): void {
    this.particleLayer.replaceChildren();
    this.particles = [];
    const lineage = this.highlight.lineage;
    if (!lineage || !this.motion) return;
    let budget = 60;
    for (const e of this.edges) {
      const dir = lineage.edges.get(e.view.id);
      if (!dir || budget <= 0) continue;
      for (let i = 0; i < 2; i++) {
        const el = s("circle", { class: `particle ${dir}`, r: 2.6 });
        this.particleLayer.append(el);
        this.particles.push({ el, edge: e, phase: i / 2 + (hash(e.view.id) % 100) / 400 });
        budget--;
      }
    }
  }

  private ripple(id: string): void {
    const n = this.nodes.get(id);
    if (!n || !this.motion) return;
    const c = s("circle", { class: "ripple", r: n.style.r });
    c.addEventListener("animationend", () => c.remove());
    n.body.prepend(c);
  }

  // ---------------------------------------------------------------- camera

  private targetPos(n: SNode): Pt {
    return this.mode === "layered" ? { x: n.tx, y: n.ty } : { x: n.x, y: n.y };
  }

  private bounds(): { minX: number; minY: number; maxX: number; maxY: number } | undefined {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const n of this.nodes.values()) {
      if (n.exiting) continue;
      const p = this.targetPos(n);
      const r = n.style.r + 12;
      minX = Math.min(minX, p.x - r - 20);
      maxX = Math.max(maxX, p.x + r + 20);
      minY = Math.min(minY, p.y - r);
      maxY = Math.max(maxY, p.y + r + 30);
    }
    return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : undefined;
  }

  private cameraTo(to: { x: number; y: number; k: number }, animate: boolean): void {
    if (!animate || !this.motion) {
      this.tf = { ...to };
      this.cam = undefined;
      this.applyCamera();
    } else {
      this.cam = { from: { ...this.tf }, to, t0: performance.now(), dur: 650 };
    }
    this.wake();
  }

  private applyCamera(): void {
    this.viewport.setAttribute(
      "transform",
      `translate(${this.tf.x.toFixed(2)},${this.tf.y.toFixed(2)}) scale(${this.tf.k.toFixed(4)})`,
    );
  }

  private zoomAt(px: number, py: number, factor: number): void {
    this.cam = undefined;
    this.fitWhenSettled = false;
    const k2 = Math.min(3.5, Math.max(0.1, this.tf.k * factor));
    this.tf.x = px - ((px - this.tf.x) * k2) / this.tf.k;
    this.tf.y = py - ((py - this.tf.y) * k2) / this.tf.k;
    this.tf.k = k2;
    this.applyCamera();
    this.drawMinimap();
  }

  private toWorld(clientX: number, clientY: number): Pt {
    const r = this.svg.getBoundingClientRect();
    return {
      x: (clientX - r.left - this.tf.x) / this.tf.k,
      y: (clientY - r.top - this.tf.y) / this.tf.k,
    };
  }

  // ---------------------------------------------------------------- input

  private bindEvents(): void {
    const svg = this.svg;
    svg.addEventListener("pointerdown", (ev) => this.onPointerDown(ev));
    svg.addEventListener(
      "wheel",
      (ev) => {
        ev.preventDefault();
        const r = svg.getBoundingClientRect();
        this.zoomAt(ev.clientX - r.left, ev.clientY - r.top, Math.exp(-ev.deltaY * 0.0015));
      },
      { passive: false },
    );
    svg.addEventListener("click", (ev) => {
      if (this.suppressClick) {
        this.suppressClick = false;
        return;
      }
      const t = ev.target as Element;
      const collapseEl = t.closest("[data-collapse]");
      if (collapseEl) return this.events.collapse(collapseEl.getAttribute("data-collapse")!);
      const tabEl = t.closest("[data-gtab]");
      const nodeEl = t.closest("[data-node]");
      const edgeEl = t.closest("[data-edge]");
      if (tabEl) {
        const spec = this.boxes.find((b) => b.spec.id === tabEl.getAttribute("data-gtab"))?.spec;
        if (spec?.collapseId) this.events.select({ type: "node", id: spec.collapseId });
      } else if (nodeEl) {
        const id = nodeEl.getAttribute("data-node")!;
        if (ev.altKey && this.mode === "force") return this.unpin(id);
        this.events.select({ type: "node", id });
      } else if (edgeEl)
        this.events.select({ type: "edge", id: edgeEl.getAttribute("data-edge")! });
      else this.events.select(undefined);
    });
    svg.addEventListener("dblclick", (ev) => {
      const id = (ev.target as Element).closest("[data-node]")?.getAttribute("data-node");
      if (id && this.nodes.get(id)?.view.expandable) this.events.expand(id);
    });
    svg.addEventListener("keydown", (ev) => {
      const id = (ev.target as Element).closest("[data-node]")?.getAttribute("data-node");
      if (!id) return;
      if (ev.key === "Enter") this.events.select({ type: "node", id });
      if (ev.key === " " && this.nodes.get(id)?.view.expandable) {
        ev.preventDefault();
        this.events.expand(id);
      }
    });
    svg.addEventListener("pointerover", (ev) =>
      this.setHover(
        (ev.target as Element).closest("[data-node]")?.getAttribute("data-node") ?? undefined,
      ),
    );
    svg.addEventListener("pointerleave", () => this.setHover(undefined));
  }

  private setHover(id: string | undefined): void {
    if (id === this.hover) return;
    this.hover = id;
    this.applyHighlight();
  }

  private unpin(id: string): void {
    const n = this.nodes.get(id);
    if (!n) return;
    n.pinned = false;
    n.el.classList.remove("pinned");
    const sn = this.sim?.node(id);
    if (sn) sn.pinned = false;
    this.reheat();
  }

  /** Every node inside a box, including nested boxes. */
  private membersOf(groupId: string): SNode[] {
    const ids = new Set<string>();
    const walk = (id: string): void => {
      const b = this.boxes.find((x) => x.spec.id === id);
      if (!b) return;
      b.nodes.forEach((n) => ids.add(n));
      b.children.forEach(walk);
    };
    walk(groupId);
    return [...ids].map((id) => this.nodes.get(id)).filter((n): n is SNode => !!n && !n.exiting);
  }

  /** Dragging a box header moves the whole segment; in live mode the physics then re-settles around it. */
  private startGroupDrag(groupId: string, ev: PointerEvent): void {
    const members = this.membersOf(groupId);
    if (!members.length) return;
    const start = this.toWorld(ev.clientX, ev.clientY);
    const origin = members.map((n) => ({ n, x: n.x, y: n.y, pinned: n.pinned }));
    const sx = ev.clientX;
    const sy = ev.clientY;
    let dragged = false;
    const move = (m: PointerEvent): void => {
      if (!dragged && Math.abs(m.clientX - sx) + Math.abs(m.clientY - sy) > 4) {
        dragged = true;
        this.cam = undefined;
        this.fitWhenSettled = false;
        if (this.sim) this.sim.alphaTarget = 0.2;
      }
      if (!dragged) return;
      const w = this.toWorld(m.clientX, m.clientY);
      for (const o of origin) {
        o.n.x = o.n.tx = o.x + (w.x - start.x);
        o.n.y = o.n.ty = o.y + (w.y - start.y);
        const sn = this.sim?.node(o.n.id);
        if (sn && this.mode === "force") {
          sn.x = o.n.x;
          sn.y = o.n.y;
          sn.pinned = true;
        }
      }
      this.wake();
    };
    const up = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (dragged) this.suppressClick = true;
      for (const o of origin) {
        const sn = this.sim?.node(o.n.id);
        if (sn) sn.pinned = o.pinned; // the box settles into place; only nodes you pinned stay pinned
      }
      if (this.sim) {
        this.sim.alphaTarget = 0;
        this.sim.reheat(0.4);
      }
      this.wake();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  private onPointerDown(ev: PointerEvent): void {
    if (ev.button !== 0) return;
    const tabEl = (ev.target as Element).closest("[data-gtab]");
    if (tabEl && !(ev.target as Element).closest("[data-collapse]")) {
      this.startGroupDrag(tabEl.getAttribute("data-gtab")!, ev);
      return;
    }
    const nodeEl = (ev.target as Element).closest("[data-node]");
    const node = nodeEl ? this.nodes.get(nodeEl.getAttribute("data-node")!) : undefined;
    const sx = ev.clientX;
    const sy = ev.clientY;
    const ox = this.tf.x;
    const oy = this.tf.y;
    const grab = node ? this.toWorld(sx, sy) : undefined;
    const off = node && grab ? { x: node.x - grab.x, y: node.y - grab.y } : undefined;
    let dragged = false;

    const move = (m: PointerEvent): void => {
      if (!dragged && Math.abs(m.clientX - sx) + Math.abs(m.clientY - sy) > 4) {
        dragged = true;
        this.cam = undefined;
        if (node && this.mode === "force" && this.sim) {
          this.sim.alphaTarget = 0.3;
          this.sim.reheat(0.6);
        }
        if (node) node.el.classList.add("dragging");
      }
      if (!dragged) return;
      if (node && off) {
        const w = this.toWorld(m.clientX, m.clientY);
        node.x = node.tx = w.x + off.x;
        node.y = node.ty = w.y + off.y;
        if (this.mode === "force") {
          node.pinned = true;
          node.el.classList.add("pinned");
          const sn = this.sim?.node(node.id);
          if (sn) {
            sn.x = node.x;
            sn.y = node.y;
            sn.pinned = true;
          }
        }
      } else {
        this.fitWhenSettled = false;
        this.tf.x = ox + m.clientX - sx;
        this.tf.y = oy + m.clientY - sy;
        this.applyCamera();
      }
      this.wake();
    };
    const up = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (dragged) this.suppressClick = true;
      if (node) node.el.classList.remove("dragging");
      if (this.sim) this.sim.alphaTarget = 0;
      this.wake();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  // ---------------------------------------------------------------- animation loop

  private wake(): void {
    if (this.raf) return;
    this.last = performance.now();
    this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  /** Jump straight to the end state (reduced motion). */
  private snap(): void {
    for (const n of this.nodes.values()) {
      n.x = n.tx;
      n.y = n.ty;
      n.scale = n.targetScale;
    }
    if (this.sim) {
      this.sim.settle(500);
      for (const sn of this.sim.nodes) {
        const n = this.nodes.get(sn.id);
        if (n) {
          n.x = n.tx = sn.x;
          n.y = n.ty = sn.y;
        }
      }
    }
    for (const [id, n] of this.nodes)
      if (n.exiting) {
        n.el.remove();
        this.nodes.delete(id);
      }
  }

  private frame(now: number): void {
    this.raf = 0;
    const frameStart = this.last;
    const dt = Math.min(0.05, Math.max(0.001, (now - this.last) / 1000));
    this.last = now;
    let moving = false;

    // Camera.
    if (this.cam) {
      const t = (now - this.cam.t0) / this.cam.dur;
      const e = easeInOutCubic(t);
      const { from, to } = this.cam;
      this.tf = {
        x: from.x + (to.x - from.x) * e,
        y: from.y + (to.y - from.y) * e,
        k: from.k + (to.k - from.k) * e,
      };
      this.applyCamera();
      if (t >= 1) this.cam = undefined;
      else moving = true;
    }

    // Physics (force mode).
    // While the layout is still spreading out, keep the camera framing it (smoothly).
    if (this.fitWhenSettled && this.mode === "force" && now - this.lastAutoFit > 500) {
      this.lastAutoFit = now;
      this.fit(true);
    }
    const simActive = this.mode === "force" && !!this.sim && this.motion;
    if (simActive && this.sim) {
      const wasActive = this.sim.active;
      // Time-based: on slow frames run extra ticks (they are cheap; drawing is the cost), so the
      // layout settles in about the same wall-clock time on any machine.
      const steps = Math.min(4, Math.max(1, Math.round(((now - frameStart) / 1000) * 60)));
      let still = true;
      for (let i = 0; i < steps && still; i++) still = this.sim.tick();
      for (const sn of this.sim.nodes) {
        const n = this.nodes.get(sn.id);
        if (n && !n.pinned) {
          n.x = sn.x;
          n.y = sn.y;
        }
      }
      if (still) moving = true;
      else if (wasActive && this.fitWhenSettled) {
        this.fitWhenSettled = false;
        this.fit(true);
        moving = true;
      }
    }

    // Per-node easing: scale always; position easing in layered mode and for exiting nodes.
    const kPos = 1 - Math.exp(-dt * 7);
    const kScale = 1 - Math.exp(-dt * 9);
    for (const [id, n] of this.nodes) {
      const ds = n.targetScale - n.scale;
      if (Math.abs(ds) > 0.004) {
        n.scale += ds * kScale;
        moving = true;
      } else n.scale = n.targetScale;
      if (this.mode === "layered" || n.exiting) {
        const dx = n.tx - n.x;
        const dy = n.ty - n.y;
        if (Math.abs(dx) + Math.abs(dy) > 0.25) {
          n.x += dx * kPos;
          n.y += dy * kPos;
          moving = true;
        } else {
          n.x = n.tx;
          n.y = n.ty;
        }
      }
      if (n.exiting && n.scale < 0.03) {
        n.el.remove();
        this.nodes.delete(id);
        continue;
      }
      n.el.setAttribute("transform", `translate(${n.x.toFixed(1)},${n.y.toFixed(1)})`);
      n.body.setAttribute("transform", `scale(${Math.max(0.001, n.scale).toFixed(3)})`);
      n.el.style.opacity = String(Math.min(1, n.scale * 1.3));
    }

    this.updateEdges();
    this.updateBoxes();
    const flowing = this.updateParticles(now);
    this.drawMinimap();
    if (moving || flowing) this.wake();
  }

  private updateEdges(): void {
    for (const e of this.edges) {
      const a = this.nodes.get(e.view.from);
      const b = this.nodes.get(e.view.to);
      if (!a || !b) continue;
      const g = edgeGeometry(a, a.style.r * a.scale, b, b.style.r * b.scale, e.side);
      e.start = g.start;
      e.ctrl = g.ctrl;
      e.end = g.end;
      e.mid = g.mid;
      e.line.setAttribute("d", g.d);
      e.hit.setAttribute("d", g.d);
      e.arrow.setAttribute(
        "transform",
        `translate(${g.tip.x.toFixed(1)},${g.tip.y.toFixed(1)}) rotate(${((g.angle * 180) / Math.PI).toFixed(1)})`,
      );
      if (e.count) {
        e.count.setAttribute("x", g.mid.x.toFixed(1));
        e.count.setAttribute("y", (g.mid.y - 5).toFixed(1));
      }
      e.badge?.setAttribute("transform", `translate(${g.mid.x.toFixed(1)},${g.mid.y.toFixed(1)})`);
      e.el.style.opacity = String(Math.min(a.scale, b.scale));
    }
  }

  /** Fit every box around its members (and nested boxes), innermost first, so nesting always encloses. */
  private updateBoxes(): void {
    if (!this.boxes.length || !this.graph) return;
    const g = this.graph;
    const pseudo: SimNode[] = [];
    for (const n of this.nodes.values()) {
      if (n.exiting || n.scale < 0.05 || !n.style.group) continue;
      pseudo.push({
        id: n.id,
        x: n.x,
        y: n.y,
        vx: 0,
        vy: 0,
        r: extentR(n.style.r, n.view.name) * n.scale,
        groups: this.pathFor(g, n),
      });
    }
    // Exactly the rectangles the physics keeps apart, so what is drawn is what was separated.
    const rects = boxRects(pseudo, this.boxMinWidth());
    for (const b of this.boxes) {
      const r = rects.get(b.key);
      if (!r) {
        b.el.style.display = "none";
        continue;
      }
      b.el.style.display = "";
      b.rect.setAttribute("x", r.x0.toFixed(1));
      b.rect.setAttribute("y", r.y0.toFixed(1));
      b.rect.setAttribute("width", Math.max(40, r.x1 - r.x0).toFixed(1));
      b.rect.setAttribute("height", Math.max(40, r.y1 - r.y0).toFixed(1));
      b.tab.setAttribute(
        "transform",
        `translate(${(r.x0 + 14).toFixed(1)},${(r.y0 + 10).toFixed(1)})`,
      );
    }
  }

  private updateParticles(now: number): boolean {
    if (!this.particles.length || !this.motion) return false;
    const t = now / 1000;
    for (const p of this.particles) {
      const u = (t * 0.32 + p.phase) % 1;
      const pt = quadAt(p.edge.start, p.edge.ctrl, p.edge.end, u);
      p.el.setAttribute("cx", pt.x.toFixed(1));
      p.el.setAttribute("cy", pt.y.toFixed(1));
      p.el.style.opacity = String(Math.sin(u * Math.PI));
    }
    return true;
  }

  // ---------------------------------------------------------------- minimap

  private mapMetrics():
    { minX: number; minY: number; scale: number; ox: number; oy: number } | undefined {
    const c = this.minimap;
    const nb = this.bounds();
    if (!c || !nb) return undefined;
    // Include the visible viewport so its box is never clipped.
    const r = this.svg.getBoundingClientRect();
    const vx = -this.tf.x / this.tf.k;
    const vy = -this.tf.y / this.tf.k;
    const minX = Math.min(nb.minX, vx);
    const minY = Math.min(nb.minY, vy);
    const maxX = Math.max(nb.maxX, vx + r.width / this.tf.k);
    const maxY = Math.max(nb.maxY, vy + r.height / this.tf.k);
    const w = maxX - minX;
    const h = maxY - minY;
    const scale = Math.min((c.width - 12) / w, (c.height - 12) / h);
    return { minX, minY, scale, ox: (c.width - w * scale) / 2, oy: (c.height - h * scale) / 2 };
  }

  private drawMinimap(): void {
    const c = this.minimap;
    const m = this.mapMetrics();
    const ctx = c?.getContext("2d");
    if (!c || !m || !ctx) return;
    ctx.clearRect(0, 0, c.width, c.height);
    const ink = getComputedStyle(c).color;
    for (const n of this.nodes.values()) {
      if (n.exiting) continue;
      ctx.beginPath();
      ctx.fillStyle = `hsl(${n.style.hue} ${n.style.sat}% 62%)`;
      ctx.globalAlpha = n.el.classList.contains("dim") ? 0.25 : 0.95;
      ctx.arc(
        (n.x - m.minX) * m.scale + m.ox,
        (n.y - m.minY) * m.scale + m.oy,
        Math.max(2, n.style.r * m.scale * 0.8),
        0,
        Math.PI * 2,
      );
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    const r = this.svg.getBoundingClientRect();
    ctx.strokeStyle = ink;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(
      (-this.tf.x / this.tf.k - m.minX) * m.scale + m.ox,
      (-this.tf.y / this.tf.k - m.minY) * m.scale + m.oy,
      (r.width / this.tf.k) * m.scale,
      (r.height / this.tf.k) * m.scale,
    );
  }
}
