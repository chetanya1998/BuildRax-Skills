export interface SimNode {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  /**
   * Containment path from the outermost box to the innermost (e.g. ["pkg", "pkg/services"]).
   * Nodes sharing a prefix attract each other; different boxes are kept apart.
   */
  groups?: string[];
  /** Pinned nodes do not move (set while dragging, kept after release). */
  pinned?: boolean;
}

export interface SimLink {
  a: string;
  b: string;
  /** Number of underlying dependencies; stronger links pull a little harder. */
  weight: number;
}

export interface SimOptions {
  repulsion: number;
  linkDistance: number;
  linkStrength: number;
  gravity: number;
  /** 0 disables package clustering. */
  cluster: number;
  velocityDecay: number;
  alphaDecay: number;
  /** Minimum width per box path key (e.g. so a box is never narrower than its header tab). */
  boxMinWidth?: ReadonlyMap<string, number>;
}

export const DEFAULT_SIM: SimOptions = {
  repulsion: 11500,
  linkDistance: 112,
  linkStrength: 0.09,
  gravity: 0.02,
  cluster: 0.11,
  velocityDecay: 0.42,
  alphaDecay: 0.03,
};

const ALPHA_MIN = 0.004;

/**
 * Small force-directed simulation (repulsion, springs, gravity, clustering, collisions).
 * Pure and deterministic: no randomness, so the same graph settles the same way every time.
 */
export class ForceSim {
  readonly nodes: SimNode[];
  alpha = 1;
  alphaTarget = 0;
  private readonly byId = new Map<string, SimNode>();
  private readonly links: { a: SimNode; b: SimNode; w: number }[] = [];
  readonly opts: SimOptions;

  constructor(nodes: SimNode[], links: SimLink[], opts: Partial<SimOptions> = {}) {
    this.opts = { ...DEFAULT_SIM, ...opts };
    this.nodes = nodes;
    nodes.forEach((n, i) => {
      this.byId.set(n.id, n);
      // Deterministic spiral for nodes that have no position yet.
      if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) {
        const ang = i * 2.399963;
        const rad = 30 * Math.sqrt(i + 1);
        n.x = Math.cos(ang) * rad;
        n.y = Math.sin(ang) * rad;
      }
    });
    for (const l of links) {
      const a = this.byId.get(l.a);
      const b = this.byId.get(l.b);
      if (a && b && a !== b) this.links.push({ a, b, w: l.weight });
    }
  }

  node(id: string): SimNode | undefined {
    return this.byId.get(id);
  }

  /** Wake the simulation up (after a drag, a new node, or the user pressing "shake"). */
  reheat(alpha = 0.7): void {
    this.alpha = Math.max(this.alpha, alpha);
  }

  get active(): boolean {
    return this.alpha > ALPHA_MIN || this.alphaTarget > 0;
  }

  /** Advance one step. Returns false once the layout has settled. */
  tick(): boolean {
    if (!this.active) return false;
    this.alpha += (this.alphaTarget - this.alpha) * this.opts.alphaDecay;
    const a = this.alpha;
    const ns = this.nodes;
    const o = this.opts;

    // Repulsion: every pair pushes apart, heavier nodes push harder.
    for (let i = 0; i < ns.length; i++) {
      const p = ns[i]!;
      for (let j = i + 1; j < ns.length; j++) {
        const q = ns[j]!;
        let dx = q.x - p.x;
        let dy = q.y - p.y;
        let d2 = dx * dx + dy * dy;
        if (d2 > 640_000) continue; // beyond 800px nodes do not feel each other
        if (d2 < 1) {
          dx = (i % 2 ? 1 : -1) * 0.5;
          dy = (j % 2 ? 1 : -1) * 0.5;
          d2 = 1;
        }
        const d = Math.sqrt(d2);
        const sameBox = innermost(p) === innermost(q);
        const f = ((o.repulsion * a) / Math.max(d2, 400)) * (sameBox ? 1 : 1.35);
        const fx = (dx / d) * f;
        const fy = (dy / d) * f;
        const mp = q.r / 18;
        const mq = p.r / 18;
        p.vx -= fx * mp;
        p.vy -= fy * mp;
        q.vx += fx * mq;
        q.vy += fy * mq;
      }
    }

    // Springs along dependencies.
    for (const l of this.links) {
      const dx = l.b.x - l.a.x;
      const dy = l.b.y - l.a.y;
      const d = Math.hypot(dx, dy) || 1;
      const rest = o.linkDistance + l.a.r + l.b.r;
      // Links that cross box boundaries pull less, so boxes stay compact instead of being stretched.
      const cross =
        o.cluster > 0 && (l.a.groups?.[0] ?? l.a.id) !== (l.b.groups?.[0] ?? l.b.id) ? 0.3 : 1;
      const k = o.linkStrength * (1 + Math.log2(l.w)) * a * cross;
      const f = ((d - rest) / d) * k;
      l.a.vx += dx * f * 0.5;
      l.a.vy += dy * f * 0.5;
      l.b.vx -= dx * f * 0.5;
      l.b.vy -= dy * f * 0.5;
    }

    // Gravity toward the origin, plus a pull toward the centroid of every box the node is in.
    const levels = o.cluster > 0 ? centroids(ns) : undefined;
    for (const n of ns) {
      n.vx -= n.x * o.gravity * a;
      n.vy -= n.y * o.gravity * a;
      if (!levels || !n.groups) continue;
      for (let l = 0; l < n.groups.length; l++) {
        const c = levels.get(pathKey(n.groups, l));
        if (c && c.n > 1) {
          n.vx += (c.x / c.n - n.x) * o.cluster * a;
          n.vy += (c.y / c.n - n.y) * o.cluster * a;
        }
      }
    }

    // Integrate.
    for (const n of ns) {
      if (n.pinned) {
        n.vx = 0;
        n.vy = 0;
        continue;
      }
      n.vx *= 1 - o.velocityDecay;
      n.vy *= 1 - o.velocityDecay;
      n.x += n.vx;
      n.y += n.vy;
    }

    if (o.cluster > 0) separateBoxes(ns, o.boxMinWidth);

    // Collisions: separate overlapping orbs (position correction, independent of alpha).
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < ns.length; i++) {
        const p = ns[i]!;
        for (let j = i + 1; j < ns.length; j++) {
          const q = ns[j]!;
          const dx = q.x - p.x;
          const dy = q.y - p.y;
          const min = p.r + q.r + 10 + (innermost(p) === innermost(q) ? 0 : 46);
          const d2 = dx * dx + dy * dy;
          if (d2 >= min * min) continue;
          const d = Math.sqrt(d2) || 0.01;
          const push = (min - d) / 2;
          const ux = d < 0.02 ? 1 : dx / d;
          const uy = d < 0.02 ? 0 : dy / d;
          if (!p.pinned) {
            p.x -= ux * push * (q.pinned ? 2 : 1);
            p.y -= uy * push * (q.pinned ? 2 : 1);
          }
          if (!q.pinned) {
            q.x += ux * push * (p.pinned ? 2 : 1);
            q.y += uy * push * (p.pinned ? 2 : 1);
          }
        }
      }
    }
    return this.active;
  }

  /** Run until settled (or `max` steps). Used for reduced-motion users and in tests. */
  settle(max = 600): number {
    let steps = 0;
    while (steps < max && this.tick()) steps++;
    return steps;
  }
}

const innermost = (n: SimNode): string | undefined => n.groups?.[n.groups.length - 1];
const pathKey = (groups: string[], level: number): string =>
  groups.slice(0, level + 1).join("\u0000");

function centroids(ns: SimNode[]): Map<string, { x: number; y: number; n: number }> {
  const out = new Map<string, { x: number; y: number; n: number }>();
  for (const n of ns) {
    if (!n.groups) continue;
    for (let l = 0; l < n.groups.length; l++) {
      const k = pathKey(n.groups, l);
      const c = out.get(k) ?? { x: 0, y: 0, n: 0 };
      c.x += n.x;
      c.y += n.y;
      c.n++;
      out.set(k, c);
    }
  }
  return out;
}

export interface BoxRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const HEADER = 44;
const BASE_PAD = 18;
const NEST_PAD = 16;
const BOX_GAP = 26;

/**
 * Bounding rectangles of every box (by path), exactly as the scene draws them: members plus
 * padding, extra room on top for the header tab, and more padding for boxes that contain boxes.
 */
export function boxRects(
  ns: SimNode[],
  minWidth?: ReadonlyMap<string, number>,
): Map<string, BoxRect & { parent: string; nodes: SimNode[] }> {
  const out = new Map<string, BoxRect & { parent: string; nodes: SimNode[]; below: number }>();
  for (const n of ns) {
    if (!n.groups) continue;
    for (let l = 0; l < n.groups.length; l++) {
      const k = pathKey(n.groups, l);
      const below = n.groups.length - l - 1;
      const b = out.get(k) ?? {
        x0: Infinity,
        y0: Infinity,
        x1: -Infinity,
        y1: -Infinity,
        parent: l === 0 ? "" : pathKey(n.groups, l - 1),
        nodes: [],
        below: 0,
      };
      b.nodes.push(n);
      b.below = Math.max(b.below, below);
      b.x0 = Math.min(b.x0, n.x - n.r);
      b.x1 = Math.max(b.x1, n.x + n.r);
      b.y0 = Math.min(b.y0, n.y - n.r);
      b.y1 = Math.max(b.y1, n.y + n.r);
      out.set(k, b);
    }
  }
  for (const [k, b] of out) {
    // A loose node beside boxes is a one-node segment: no header tab, little padding.
    const loose = k.slice(k.lastIndexOf("\u0000") + 1).startsWith("free:");
    const pad = loose ? 6 : BASE_PAD + NEST_PAD * b.below;
    b.x0 -= pad;
    b.x1 += pad;
    b.y0 -= pad + (loose ? 0 : HEADER);
    b.y1 += pad;
    const min = minWidth?.get(k);
    if (min && b.x1 - b.x0 < min) {
      const grow = (min - (b.x1 - b.x0)) / 2;
      b.x0 -= grow;
      b.x1 += grow;
    }
  }
  // Parents must enclose their children's final rectangles (which may have grown to fit a tab),
  // with a margin and room under the parent's own header. Deepest boxes first.
  const depthOf = (k: string): number => k.split("\u0000").length;
  for (const [k, c] of [...out].sort((a, b) => depthOf(b[0]) - depthOf(a[0]))) {
    const p = c.parent ? out.get(c.parent) : undefined;
    if (!p || k === c.parent) continue;
    p.x0 = Math.min(p.x0, c.x0 - 12);
    p.x1 = Math.max(p.x1, c.x1 + 12);
    p.y1 = Math.max(p.y1, c.y1 + 12);
    p.y0 = Math.min(p.y0, c.y0 - 40);
  }
  return out;
}

/**
 * Keep sibling boxes (and loose nodes, which count as one-node boxes) from overlapping. Overlap is
 * resolved on the drawn rectangles, along the axis with the least overlap, by moving every member
 * of each box. Pinned nodes stay put; the other side takes the whole correction.
 */
function separateBoxes(ns: SimNode[], minWidth?: ReadonlyMap<string, number>): void {
  for (let pass = 0; pass < 3; pass++) {
    const rects = boxRects(ns, minWidth);
    const byParent = new Map<string, string[]>();
    for (const [k, b] of rects) byParent.set(b.parent, [...(byParent.get(b.parent) ?? []), k]);
    for (const keys of byParent.values()) {
      for (let i = 0; i < keys.length; i++) {
        for (let j = i + 1; j < keys.length; j++) {
          const a = rects.get(keys[i]!)!;
          const c = rects.get(keys[j]!)!;
          const ox = Math.min(a.x1, c.x1) - Math.max(a.x0, c.x0) + BOX_GAP;
          const oy = Math.min(a.y1, c.y1) - Math.max(a.y0, c.y0) + BOX_GAP;
          if (ox <= 0 || oy <= 0) continue;
          const horizontal = ox < oy;
          const dir = horizontal
            ? Math.sign(a.x0 + a.x1 - (c.x0 + c.x1)) || 1
            : Math.sign(a.y0 + a.y1 - (c.y0 + c.y1)) || 1; // +: a is after c
          const amount = horizontal ? ox : oy;
          const aFree = a.nodes.some((n) => !n.pinned);
          const cFree = c.nodes.some((n) => !n.pinned);
          const share = aFree && cFree ? 0.5 : 1;
          const move = (nodes: SimNode[], d: number): void => {
            for (const n of nodes) {
              if (n.pinned) continue;
              if (horizontal) n.x += d;
              else n.y += d;
            }
          };
          if (aFree) move(a.nodes, dir * amount * share);
          if (cFree) move(c.nodes, -dir * amount * share);
        }
      }
    }
  }
}
