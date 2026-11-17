export interface Pt {
  x: number;
  y: number;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Orb radius: containers grow with the files they hold, files with their connections. */
export function radiusFor(kind: string, fileCount: number, degree: number): number {
  switch (kind) {
    case "project":
      return 34;
    case "module":
      return 19 + clamp(4 * Math.sqrt(fileCount), 0, 20);
    case "file":
      return 12 + clamp(2 * Math.log2(1 + degree), 0, 9);
    case "external":
      return 13 + clamp(degree, 0, 7);
    case "unresolved":
      return 13;
    default:
      return 14;
  }
}

export const labelWidth = (name: string): number =>
  Math.min(190, Math.round(name.length * 6.8 + 10));

/** Layout box for an orb plus its label underneath. */
export function nodeBox(r: number, name: string): { w: number; h: number } {
  return { w: Math.max(2 * r + 10, labelWidth(name)), h: 2 * r + 30 };
}

export const easeOutCubic = (t: number): number => 1 - Math.pow(1 - clamp(t, 0, 1), 3);
export const easeInOutCubic = (t: number): number => {
  const x = clamp(t, 0, 1);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
};

export const quadAt = (p0: Pt, p1: Pt, p2: Pt, t: number): Pt => {
  const u = 1 - t;
  return {
    x: u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x,
    y: u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y,
  };
};

export interface EdgeGeom {
  d: string;
  start: Pt;
  ctrl: Pt;
  /** Where the curved line ends (just before the arrowhead). */
  end: Pt;
  /** Arrow tip, on the target orb's rim. */
  tip: Pt;
  mid: Pt;
  /** Direction of travel at the target, in radians. */
  angle: number;
}

const norm = (v: Pt): Pt => {
  const l = Math.hypot(v.x, v.y) || 1;
  return { x: v.x / l, y: v.y / l };
};

/**
 * Curved edge between two orbs. `side` bends the curve to one side so that A->B and B->A do not
 * overlap. Endpoints are trimmed to the orbs' rims so arrowheads touch the target.
 */
export function edgeGeometry(a: Pt, ra: number, b: Pt, rb: number, side: 1 | -1): EdgeGeom {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  const n = len < 1e-6 ? { x: 0, y: 0 } : { x: -dy / len, y: dx / len };
  const bend = side * clamp(len * 0.16, 10, 56);
  const ctrl = { x: (a.x + b.x) / 2 + n.x * bend * 2, y: (a.y + b.y) / 2 + n.y * bend * 2 };
  const sdir = norm({ x: ctrl.x - a.x, y: ctrl.y - a.y });
  const edir = norm({ x: b.x - ctrl.x, y: b.y - ctrl.y });
  const start = { x: a.x + sdir.x * (ra + 2), y: a.y + sdir.y * (ra + 2) };
  const tip = { x: b.x - edir.x * (rb + 3), y: b.y - edir.y * (rb + 3) };
  const end = { x: tip.x - edir.x * 7, y: tip.y - edir.y * 7 };
  return {
    d: `M${start.x.toFixed(1)},${start.y.toFixed(1)} Q${ctrl.x.toFixed(1)},${ctrl.y.toFixed(1)} ${end.x.toFixed(1)},${end.y.toFixed(1)}`,
    start,
    ctrl,
    end,
    tip,
    mid: quadAt(start, ctrl, end, 0.5),
    angle: Math.atan2(edir.y, edir.x),
  };
}
