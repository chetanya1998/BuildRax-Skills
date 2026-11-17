export interface SimNode {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  /** Cluster key (e.g. owning package); nodes with the same key attract each other. */
  group?: string;
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
}

export const DEFAULT_SIM: SimOptions = {
  repulsion: 11500,
  linkDistance: 112,
  linkStrength: 0.09,
  gravity: 0.02,
  cluster: 0.06,
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
        const f = (o.repulsion * a) / Math.max(d2, 400);
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
      const k = o.linkStrength * (1 + Math.log2(l.w)) * a;
      const f = ((d - rest) / d) * k;
      l.a.vx += dx * f * 0.5;
      l.a.vy += dy * f * 0.5;
      l.b.vx -= dx * f * 0.5;
      l.b.vy -= dy * f * 0.5;
    }

    // Gravity toward the origin and optional pull toward the group's centroid.
    const cent = new Map<string, { x: number; y: number; n: number }>();
    if (o.cluster > 0) {
      for (const n of ns) {
        if (!n.group) continue;
        const c = cent.get(n.group) ?? { x: 0, y: 0, n: 0 };
        c.x += n.x;
        c.y += n.y;
        c.n++;
        cent.set(n.group, c);
      }
    }
    for (const n of ns) {
      n.vx -= n.x * o.gravity * a;
      n.vy -= n.y * o.gravity * a;
      const c = n.group ? cent.get(n.group) : undefined;
      if (c && c.n > 1) {
        n.vx += (c.x / c.n - n.x) * o.cluster * a;
        n.vy += (c.y / c.n - n.y) * o.cluster * a;
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

    // Collisions: separate overlapping orbs (position correction, independent of alpha).
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < ns.length; i++) {
        const p = ns[i]!;
        for (let j = i + 1; j < ns.length; j++) {
          const q = ns[j]!;
          const dx = q.x - p.x;
          const dy = q.y - p.y;
          const min = p.r + q.r + 10;
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
