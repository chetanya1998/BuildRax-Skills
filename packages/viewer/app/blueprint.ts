import type { GraphView, ViewNode } from "@buildrax/graph";
import { INFRA_ICONS } from "./icons.js";
import type { BlueprintLayout, Box } from "./blueprint-layout.js";
import { put, s } from "./dom.js";
import { easeInOutCubic, type Pt } from "./geometry.js";
import type { GroupSpec } from "./groups.js";
import type { Lineage } from "./lineage.js";
import type { Badge } from "./notes-logic.js";
import type { NodeStyle, Selection } from "./scene.js";

export interface BlueprintGraph {
  view: GraphView;
  layout: BlueprintLayout;
  style: Map<string, NodeStyle>;
  groups: GroupSpec[];
}

export interface BlueprintHighlight {
  selected?: Selection;
  lineage?: Lineage;
  focusKey?: string;
  /** Hop number per traced arrow, drawn as numbered badges. */
  steps?: Map<string, { n: number; direction: "downstream" | "upstream" }>;
}

export interface BlueprintEvents {
  select(sel: Selection | undefined): void;
  activate(id: string, expandable: boolean): void;
  collapse(id: string): void;
}

const ICONS: Record<string, string> = {
  module: "M0,-7 L6,-3.5 L6,3.5 L0,7 L-6,3.5 L-6,-3.5 Z M0,0 L0,7 M0,0 L6,-3.5 M0,0 L-6,-3.5",
  file: "M-4,-6 L2,-6 L5,-3 L5,6 L-4,6 Z M2,-6 L2,-3 L5,-3 M-2,0 L3,0 M-2,3 L3,3",
  external: "M-6,0 A6,6 0 1 0 6,0 A6,6 0 1 0 -6,0 M-6,0 L6,0 M0,-6 Q-4,0 0,6 M0,-6 Q4,0 0,6",
  unresolved: "M-3,-3 Q-3,-6 0,-6 Q3,-6 3,-3 Q3,-1 0,1 L0,3 M0,6 L0,6.5",
  ...INFRA_ICONS,
};

const truncate = (t: string, max: number): string =>
  t.length <= max ? t : `${t.slice(0, Math.max(1, max - 1))}…`;

/** Orthogonal polyline with softly rounded corners. */
export function roundedPath(pts: readonly Pt[], radius = 7): string {
  if (pts.length < 2) return "";
  let d = `M${pts[0]!.x.toFixed(1)},${pts[0]!.y.toFixed(1)}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i - 1]!;
    const c = pts[i]!;
    const n = pts[i + 1]!;
    const r = Math.min(
      radius,
      Math.hypot(c.x - p.x, c.y - p.y) / 2,
      Math.hypot(n.x - c.x, n.y - c.y) / 2,
    );
    const a = {
      x: c.x - (Math.sign(c.x - p.x) * r || 0),
      y: c.y - (Math.sign(c.y - p.y) * r || 0),
    };
    const b = {
      x: c.x + (Math.sign(n.x - c.x) * r || 0),
      y: c.y + (Math.sign(n.y - c.y) * r || 0),
    };
    d += ` L${a.x.toFixed(1)},${a.y.toFixed(1)} Q${c.x.toFixed(1)},${c.y.toFixed(1)} ${b.x.toFixed(1)},${b.y.toFixed(1)}`;
  }
  const last = pts[pts.length - 1]!;
  return `${d} L${last.x.toFixed(1)},${last.y.toFixed(1)}`;
}

/** Where to put a step badge: the middle of the route's longest segment. */
export function badgePoint(pts: readonly Pt[]): Pt {
  let best = 0;
  let at: Pt = pts[0] ?? { x: 0, y: 0 };
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len > best) {
      best = len;
      at = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    }
  }
  return at;
}

interface CardEl {
  view: ViewNode;
  el: SVGGElement;
  box: Box;
  badge?: SVGGElement;
}

/**
 * Node view renderer: a structured blueprint of rectangular cards in left-to-right layers, frames
 * for segments, and orthogonal arrows routed around the cards. Nothing moves on its own; changes
 * animate (cards glide, arrows fade in once they arrive).
 */
export class Blueprint {
  private readonly viewport = s("g", { class: "bp-viewport" });
  private readonly frameLayer = s("g", { class: "bp-frames" });
  private readonly edgeLayer = s("g", { class: "bp-edges" });
  private readonly stepLayer = s("g", { class: "bp-steps" });
  private readonly cardLayer = s("g", { class: "bp-cards" });
  private cards = new Map<string, CardEl>();
  private edges = new Map<string, { el: SVGGElement; route: Pt[]; from: string; to: string }>();
  private graph: BlueprintGraph | undefined;
  private highlight: BlueprintHighlight = {};
  private hover: string | undefined;
  private tf = { x: 0, y: 0, k: 1 };
  private anim = 0;
  private active = false;
  private suppressClick = false;
  private minimap: HTMLCanvasElement | undefined;
  private nodeBadges = new Map<string, Badge>();

  constructor(
    readonly svg: SVGSVGElement,
    private readonly events: BlueprintEvents,
  ) {
    svg.append(
      s(
        "defs",
        null,
        s(
          "pattern",
          { id: "bp-grid-minor", width: 8, height: 8, patternUnits: "userSpaceOnUse" },
          s("path", { d: "M8,0 L0,0 0,8", class: "grid-minor" }),
        ),
        s(
          "pattern",
          { id: "bp-grid-major", width: 48, height: 48, patternUnits: "userSpaceOnUse" },
          s("rect", { width: 48, height: 48, fill: "url(#bp-grid-minor)" }),
          s("path", { d: "M48,0 L0,0 0,48", class: "grid-major" }),
        ),
      ),
      this.viewport,
    );
    this.viewport.append(
      s("rect", { x: -20000, y: -20000, width: 40000, height: 40000, fill: "url(#bp-grid-major)" }),
      this.frameLayer,
      this.edgeLayer,
      this.stepLayer,
      this.cardLayer,
    );
    this.bindEvents();
    let last = { w: 0, h: 0 };
    new ResizeObserver(() => {
      const r = svg.getBoundingClientRect();
      if (last.w && last.h && r.width && r.height && (r.width !== last.w || r.height !== last.h)) {
        this.tf.x += (r.width - last.w) / 2;
        this.tf.y += (r.height - last.h) / 2;
        this.applyCamera();
      }
      last = { w: r.width, h: r.height };
    }).observe(svg);
  }

  setActive(on: boolean): void {
    this.active = on;
    if (on) this.drawMinimap();
  }

  attachMinimap(canvas: HTMLCanvasElement): void {
    this.minimap = canvas;
    canvas.addEventListener("pointerdown", (ev) => {
      if (!this.active) return;
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

  wakeMinimap(): void {
    this.drawMinimap();
  }

  setGraph(g: BlueprintGraph, opts: { fit?: boolean } = {}): void {
    this.graph = g;
    const keep = new Set<string>();
    for (const vn of g.view.nodes) {
      const box = g.layout.cards.get(vn.id);
      if (!box) continue;
      keep.add(vn.id);
      const existing = this.cards.get(vn.id);
      const card = existing ?? this.createCard(vn);
      card.view = vn;
      card.box = box;
      this.drawCard(card, g.style.get(vn.id));
      card.el.style.transform = `translate(${box.x}px, ${box.y}px)`;
      if (!existing) card.el.classList.add("enter");
      this.cards.set(vn.id, card);
    }
    for (const [id, c] of this.cards) {
      if (keep.has(id)) continue;
      c.el.remove();
      this.cards.delete(id);
    }
    this.drawFrames(g);
    this.drawEdges(g);
    this.applyBadges();
    this.applyHighlight();
    // Re-run the "arrive" fade so arrows appear once the cards have glided into place.
    for (const layer of [this.edgeLayer, this.frameLayer, this.stepLayer]) {
      layer.classList.remove("arrive");
      void layer.getBoundingClientRect();
      layer.classList.add("arrive");
    }
    if (opts.fit) this.fit(true);
    this.drawMinimap();
  }

  setHighlight(h: BlueprintHighlight): void {
    this.highlight = h;
    this.applyHighlight();
    this.drawSteps();
    this.drawMinimap();
  }

  setBadges(nodes: Map<string, Badge>): void {
    this.nodeBadges = nodes;
    this.applyBadges();
  }

  restyle(style: Map<string, NodeStyle>): void {
    if (!this.graph) return;
    this.graph = { ...this.graph, style };
    for (const c of this.cards.values()) this.drawCard(c, style.get(c.view.id));
    this.applyBadges();
    this.applyHighlight();
    this.drawMinimap();
  }

  fit(animate = true): void {
    const b = this.bounds();
    const r = this.svg.getBoundingClientRect();
    if (!b || !r.width || !r.height) return;
    const k = Math.max(0.15, Math.min((r.width - 100) / b.w, (r.height - 100) / b.h, 1.25));
    this.cameraTo(
      { k, x: (r.width - b.w * k) / 2 - b.x * k, y: (r.height - b.h * k) / 2 - b.y * k },
      animate,
    );
  }

  centerOn(id: string, animate = true): void {
    const c = this.cards.get(id);
    const r = this.svg.getBoundingClientRect();
    if (!c || !r.width) return;
    const k = Math.min(1.4, Math.max(0.75, this.tf.k));
    this.cameraTo(
      {
        k,
        x: r.width / 2 - (c.box.x + c.box.w / 2) * k,
        y: r.height / 2 - (c.box.y + c.box.h / 2) * k,
      },
      animate,
    );
  }

  zoomBy(factor: number): void {
    const r = this.svg.getBoundingClientRect();
    this.zoomAt(r.width / 2, r.height / 2, factor);
  }

  // ------------------------------------------------------------ drawing

  private createCard(vn: ViewNode): CardEl {
    const el = s("g", { class: "card", "data-node": vn.id, tabindex: 0, role: "button" });
    this.cardLayer.append(el);
    return { view: vn, el, box: { x: 0, y: 0, w: 0, h: 0 } };
  }

  private drawCard(c: CardEl, st: NodeStyle | undefined): void {
    const { view: vn, box, el } = c;
    el.setAttribute(
      "class",
      `card kind-${vn.kind}${vn.inCycle ? " cycle" : ""}${vn.expandable ? " expandable" : ""}${el.classList.contains("enter") ? " enter" : ""}`,
    );
    el.setAttribute(
      "style",
      `--h:${st?.hue ?? 215};--s:${st?.sat ?? 40}%;transform:translate(${box.x}px, ${box.y}px)`,
    );
    el.setAttribute("aria-label", `${vn.kind} ${vn.name}`);
    const sub = vn.expandable
      ? `${vn.kind === "module" ? "package / folder" : vn.kind} · ${vn.fileCount} file${vn.fileCount === 1 ? "" : "s"}`
      : vn.kind;
    const maxChars = Math.floor((box.w - 58) / 7.4);
    el.replaceChildren();
    put(
      el,
      s("rect", { class: "card-bg", width: box.w, height: box.h, rx: 10 }),
      s("rect", { class: "card-stripe", width: 5, height: box.h - 12, x: 0, y: 6, rx: 2.5 }),
      s("circle", { class: "card-icon-bg", cx: 26, cy: box.h / 2, r: 13 }),
      s("path", {
        class: "card-icon",
        d: ICONS[vn.kind] ?? ICONS.file!,
        transform: `translate(26,${box.h / 2})`,
      }),
      s("text", { class: "card-title", x: 48, y: box.h / 2 - 3 }, truncate(vn.name, maxChars)),
      s("text", { class: "card-sub", x: 48, y: box.h / 2 + 13 }, truncate(sub, maxChars + 4)),
      vn.expandable
        ? s("text", { class: "card-more", x: box.w - 12, y: box.h / 2 + 4 }, "+")
        : null,
      s("title", null, `${vn.kind}: ${vn.name}${vn.expandable ? " (double-click to open)" : ""}`),
    );
  }

  private drawFrames(g: BlueprintGraph): void {
    this.frameLayer.replaceChildren();
    for (const spec of g.groups) {
      const b = g.layout.frames.get(spec.id);
      if (!b) continue;
      const head = s(
        "g",
        { class: "frame-head", transform: `translate(${b.x + 12},${b.y + 10})` },
        s("text", { class: "frame-title", x: 0, y: 14 }, spec.label),
        s("text", { class: "frame-sub", x: spec.label.length * 9 + 10, y: 14 }, spec.sub),
      );
      if (spec.collapseId) {
        const btn = s(
          "g",
          {
            class: "frame-collapse",
            "data-collapse": spec.collapseId,
            role: "button",
            "aria-label": `Collapse ${spec.label}`,
            transform: `translate(${b.w - 36},10)`,
          },
          s("rect", { width: 22, height: 18, rx: 5 }),
          s("path", { d: "M6,9 L16,9" }),
          s("title", null, "Collapse back into one card"),
        );
        head.append(btn);
      }
      this.frameLayer.append(
        s(
          "g",
          {
            class: `frame depth-${Math.min(spec.depth, 3)} kind-${spec.kind}`,
            style: `--h:${spec.hue}`,
            "data-frame": spec.id,
          },
          s("rect", { class: "frame-box", x: b.x, y: b.y, width: b.w, height: b.h, rx: 14 }),
          head,
        ),
      );
    }
    // Place each caption right after its title, measured once the text is on screen.
    for (const head of this.frameLayer.querySelectorAll<SVGGElement>(".frame-head")) {
      const title = head.querySelector<SVGTextElement>(".frame-title");
      const sub = head.querySelector<SVGTextElement>(".frame-sub");
      const len = title?.getComputedTextLength?.() ?? 0;
      if (title && sub && len > 0) sub.setAttribute("x", (len + 10).toFixed(1));
    }
  }

  private drawEdges(g: BlueprintGraph): void {
    this.edgeLayer.replaceChildren();
    this.edges.clear();
    for (const e of g.view.edges) {
      const route = g.layout.routes.get(e.id);
      if (!route || route.length < 2) continue;
      const end = route[route.length - 1]!;
      const prev = route[route.length - 2]!;
      const angle = (Math.atan2(end.y - prev.y, end.x - prev.x) * 180) / Math.PI;
      const d = roundedPath(route);
      const el = s(
        "g",
        {
          class: `bp-edge${e.inCycle ? " cycle" : ""}`,
          "data-edge": e.id,
          style: `--w:${(1.2 + Math.min(2, Math.log2(e.count))).toFixed(2)}`,
        },
        s("path", { class: "hit", d }),
        s("path", { class: "line", d }),
        s("path", {
          class: "arrow",
          d: "M0,0 L-9,-4.5 L-7,0 L-9,4.5 Z",
          transform: `translate(${end.x.toFixed(1)},${end.y.toFixed(1)}) rotate(${angle.toFixed(0)})`,
        }),
      );
      if (e.count > 1) {
        const p = badgePoint(route);
        el.append(s("text", { class: "bp-count", x: p.x, y: p.y - 6 }, `×${e.count}`));
      }
      this.edgeLayer.append(el);
      this.edges.set(e.id, { el, route, from: e.from, to: e.to });
    }
  }

  /** Numbered step badges on traced arrows (1 = first hop from the selection). */
  private drawSteps(): void {
    this.stepLayer.replaceChildren();
    const steps = this.highlight.steps;
    if (!steps) return;
    for (const [id, st] of steps) {
      const e = this.edges.get(id);
      if (!e) continue;
      const p = badgePoint(e.route);
      this.stepLayer.append(
        s(
          "g",
          {
            class: `bp-step ${st.direction}`,
            transform: `translate(${p.x.toFixed(1)},${p.y.toFixed(1)})`,
          },
          s("circle", { r: 10 }),
          s("text", { y: 4 }, String(st.n)),
          s(
            "title",
            null,
            `Step ${st.n}: ${st.direction === "downstream" ? "uses" : "is used by"}`,
          ),
        ),
      );
    }
  }

  private applyHighlight(): void {
    const { lineage, selected, focusKey } = this.highlight;
    const style = this.graph?.style;
    for (const [id, c] of this.cards) {
      const role = lineage?.roles.get(id);
      const off = (!!lineage && !role) || (!!focusKey && style?.get(id)?.key !== focusKey);
      c.el.classList.toggle("dim", off);
      c.el.classList.toggle("upstream", role === "upstream");
      c.el.classList.toggle("downstream", role === "downstream");
      c.el.classList.toggle("selected", selected?.type === "node" && selected.id === id);
      c.el.classList.toggle("hover", id === this.hover);
    }
    for (const [id, e] of this.edges) {
      const dir = lineage?.edges.get(id);
      const traced = dir && lineage?.roles.has(e.from) && lineage.roles.has(e.to);
      const hot = !!this.hover && (e.from === this.hover || e.to === this.hover);
      e.el.classList.toggle(
        "dim",
        (!!lineage && !traced && !hot) ||
          (!!focusKey &&
            style?.get(e.from)?.key !== focusKey &&
            style?.get(e.to)?.key !== focusKey),
      );
      e.el.classList.toggle("upstream", !!traced && dir === "upstream");
      e.el.classList.toggle("downstream", !!traced && dir === "downstream");
      e.el.classList.toggle("hot", hot);
      e.el.classList.toggle("selected", selected?.type === "edge" && selected.id === id);
    }
    for (const f of this.frameLayer.querySelectorAll<SVGGElement>("[data-frame]"))
      f.classList.toggle("dim", !!lineage && !this.frameActive(f));
  }

  private frameActive(f: SVGGElement): boolean {
    const box = f.querySelector(".frame-box");
    if (!box) return false;
    const fx = Number(box.getAttribute("x"));
    const fy = Number(box.getAttribute("y"));
    const fw = Number(box.getAttribute("width"));
    const fh = Number(box.getAttribute("height"));
    for (const [id, c] of this.cards) {
      if (!this.highlight.lineage?.roles.has(id)) continue;
      if (
        c.box.x >= fx &&
        c.box.y >= fy &&
        c.box.x + c.box.w <= fx + fw &&
        c.box.y + c.box.h <= fy + fh
      )
        return true;
    }
    return false;
  }

  private applyBadges(): void {
    for (const c of this.cards.values()) {
      c.badge?.remove();
      c.badge = undefined;
      const b = this.nodeBadges.get(c.view.id);
      if (!b) continue;
      c.badge = s(
        "g",
        { class: `note-badge dot-${b.color}`, transform: `translate(${c.box.w - 4},4)` },
        s("circle", { r: 9 }),
        s("text", { y: 3.5 }, String(b.count)),
      );
      c.el.append(c.badge);
    }
  }

  // ------------------------------------------------------------ camera & input

  private bounds(): Box | undefined {
    const L = this.graph?.layout;
    if (!L || !L.cards.size) return undefined;
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    for (const b of [...L.cards.values(), ...L.frames.values()]) {
      x0 = Math.min(x0, b.x);
      y0 = Math.min(y0, b.y);
      x1 = Math.max(x1, b.x + b.w);
      y1 = Math.max(y1, b.y + b.h);
    }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  private applyCamera(): void {
    this.viewport.setAttribute(
      "transform",
      `translate(${this.tf.x.toFixed(2)},${this.tf.y.toFixed(2)}) scale(${this.tf.k.toFixed(4)})`,
    );
    this.drawMinimap();
  }

  private cameraTo(to: { x: number; y: number; k: number }, animate: boolean): void {
    cancelAnimationFrame(this.anim);
    const reduce =
      document.body.classList.contains("no-motion") ||
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (!animate || reduce) {
      this.tf = { ...to };
      this.applyCamera();
      return;
    }
    const from = { ...this.tf };
    const t0 = performance.now();
    const step = (now: number): void => {
      const t = Math.min(1, (now - t0) / 550);
      const e = easeInOutCubic(t);
      this.tf = {
        x: from.x + (to.x - from.x) * e,
        y: from.y + (to.y - from.y) * e,
        k: from.k + (to.k - from.k) * e,
      };
      this.applyCamera();
      if (t < 1) this.anim = requestAnimationFrame(step);
    };
    this.anim = requestAnimationFrame(step);
  }

  private zoomAt(px: number, py: number, factor: number): void {
    cancelAnimationFrame(this.anim);
    const k2 = Math.min(3, Math.max(0.12, this.tf.k * factor));
    this.tf.x = px - ((px - this.tf.x) * k2) / this.tf.k;
    this.tf.y = py - ((py - this.tf.y) * k2) / this.tf.k;
    this.tf.k = k2;
    this.applyCamera();
  }

  private bindEvents(): void {
    const svg = this.svg;
    svg.addEventListener(
      "wheel",
      (ev) => {
        ev.preventDefault();
        const r = svg.getBoundingClientRect();
        this.zoomAt(ev.clientX - r.left, ev.clientY - r.top, Math.exp(-ev.deltaY * 0.0015));
      },
      { passive: false },
    );
    svg.addEventListener("pointerdown", (ev) => {
      if (ev.button !== 0) return;
      cancelAnimationFrame(this.anim);
      const sx = ev.clientX,
        sy = ev.clientY,
        ox = this.tf.x,
        oy = this.tf.y;
      let dragged = false;
      const move = (m: PointerEvent): void => {
        if (!dragged && Math.abs(m.clientX - sx) + Math.abs(m.clientY - sy) > 4) dragged = true;
        if (!dragged) return;
        this.tf.x = ox + m.clientX - sx;
        this.tf.y = oy + m.clientY - sy;
        this.applyCamera();
      };
      const up = (): void => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        if (dragged) this.suppressClick = true;
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });
    svg.addEventListener("click", (ev) => {
      if (this.suppressClick) {
        this.suppressClick = false;
        return;
      }
      const t = ev.target as Element;
      const collapse = t.closest("[data-collapse]");
      if (collapse) return this.events.collapse(collapse.getAttribute("data-collapse")!);
      const card = t.closest("[data-node]");
      const edge = t.closest("[data-edge]");
      if (card) this.events.select({ type: "node", id: card.getAttribute("data-node")! });
      else if (edge) this.events.select({ type: "edge", id: edge.getAttribute("data-edge")! });
      else this.events.select(undefined);
    });
    svg.addEventListener("dblclick", (ev) => {
      const id = (ev.target as Element).closest("[data-node]")?.getAttribute("data-node");
      const c = id ? this.cards.get(id) : undefined;
      if (id && c) this.events.activate(id, c.view.expandable);
    });
    svg.addEventListener("keydown", (ev) => {
      const id = (ev.target as Element).closest("[data-node]")?.getAttribute("data-node");
      if (!id) return;
      if (ev.key === "Enter") this.events.select({ type: "node", id });
      if (ev.key === " ") {
        ev.preventDefault();
        this.events.activate(id, !!this.cards.get(id)?.view.expandable);
      }
    });
    svg.addEventListener("pointerover", (ev) => {
      const id =
        (ev.target as Element).closest("[data-node]")?.getAttribute("data-node") ?? undefined;
      if (id === this.hover) return;
      this.hover = id;
      this.applyHighlight();
    });
    svg.addEventListener("pointerleave", () => {
      this.hover = undefined;
      this.applyHighlight();
    });
  }

  // ------------------------------------------------------------ minimap

  private mapMetrics():
    { minX: number; minY: number; scale: number; ox: number; oy: number } | undefined {
    const c = this.minimap;
    const b = this.bounds();
    if (!c || !b) return undefined;
    const r = this.svg.getBoundingClientRect();
    const vx = -this.tf.x / this.tf.k;
    const vy = -this.tf.y / this.tf.k;
    const minX = Math.min(b.x, vx);
    const minY = Math.min(b.y, vy);
    const w = Math.max(b.x + b.w, vx + r.width / this.tf.k) - minX;
    const h = Math.max(b.y + b.h, vy + r.height / this.tf.k) - minY;
    const scale = Math.min((c.width - 12) / w, (c.height - 12) / h);
    return { minX, minY, scale, ox: (c.width - w * scale) / 2, oy: (c.height - h * scale) / 2 };
  }

  private drawMinimap(): void {
    if (!this.active) return;
    const c = this.minimap;
    const m = this.mapMetrics();
    const ctx = c?.getContext("2d");
    if (!c || !m || !ctx) return;
    ctx.clearRect(0, 0, c.width, c.height);
    for (const card of this.cards.values()) {
      const st = this.graph?.style.get(card.view.id);
      ctx.globalAlpha = card.el.classList.contains("dim") ? 0.25 : 0.95;
      ctx.fillStyle = `hsl(${st?.hue ?? 215} ${st?.sat ?? 40}% 60%)`;
      ctx.fillRect(
        (card.box.x - m.minX) * m.scale + m.ox,
        (card.box.y - m.minY) * m.scale + m.oy,
        Math.max(2, card.box.w * m.scale),
        Math.max(2, card.box.h * m.scale),
      );
    }
    ctx.globalAlpha = 1;
    const r = this.svg.getBoundingClientRect();
    ctx.strokeStyle = getComputedStyle(c).color;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(
      (-this.tf.x / this.tf.k - m.minX) * m.scale + m.ox,
      (-this.tf.y / this.tf.k - m.minY) * m.scale + m.oy,
      (r.width / this.tf.k) * m.scale,
      (r.height / this.tf.k) * m.scale,
    );
  }
}
