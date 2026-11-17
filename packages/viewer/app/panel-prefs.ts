/** How a sidebar is shown: in the layout, hidden behind an edge tab, or as a floating window. */
export type PanelMode = "docked" | "collapsed" | "floating";
export type Side = "left" | "right";

export interface FloatRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PanelPrefs {
  left: PanelMode;
  right: PanelMode;
  minimap: boolean;
  legend: boolean;
  /** Last floating window geometry; x < 0 means "not placed yet". */
  leftFloat: FloatRect;
  rightFloat: FloatRect;
}

export const DEFAULT_PANELS: PanelPrefs = {
  left: "docked",
  right: "docked",
  minimap: true,
  legend: true,
  leftFloat: { x: -1, y: 16, w: 260, h: 440 },
  rightFloat: { x: -1, y: 16, w: 380, h: 560 },
};

export const MIN_FLOAT = { w: 220, h: 160 };
const MODES: readonly PanelMode[] = ["docked", "collapsed", "floating"];

const isMode = (v: unknown): v is PanelMode => MODES.includes(v as PanelMode);
const isRect = (v: unknown): v is FloatRect => {
  const r = v as FloatRect;
  return !!r && [r.x, r.y, r.w, r.h].every((n) => typeof n === "number" && Number.isFinite(n));
};

/** Read saved preferences; anything missing or malformed falls back to the defaults. */
export function parsePanelPrefs(raw: string | null | undefined): PanelPrefs {
  if (!raw) return structuredClone(DEFAULT_PANELS);
  try {
    const v = JSON.parse(raw) as Partial<PanelPrefs>;
    return {
      left: isMode(v.left) ? v.left : DEFAULT_PANELS.left,
      right: isMode(v.right) ? v.right : DEFAULT_PANELS.right,
      minimap: typeof v.minimap === "boolean" ? v.minimap : DEFAULT_PANELS.minimap,
      legend: typeof v.legend === "boolean" ? v.legend : DEFAULT_PANELS.legend,
      leftFloat: isRect(v.leftFloat) ? v.leftFloat : { ...DEFAULT_PANELS.leftFloat },
      rightFloat: isRect(v.rightFloat) ? v.rightFloat : { ...DEFAULT_PANELS.rightFloat },
    };
  } catch {
    return structuredClone(DEFAULT_PANELS);
  }
}

/**
 * Keep a floating window inside its container, at least MIN_FLOAT in size. A window that has not
 * been placed yet goes to the left or right edge for its side.
 */
export function clampFloat(
  r: FloatRect,
  container: { w: number; h: number },
  side: Side,
): FloatRect {
  const margin = 8;
  const w = Math.max(MIN_FLOAT.w, Math.min(r.w, container.w - 2 * margin));
  const h = Math.max(MIN_FLOAT.h, Math.min(r.h, container.h - 2 * margin));
  const unplaced = r.x < 0;
  const x0 = unplaced ? (side === "left" ? 16 : container.w - w - 16) : r.x;
  const x = Math.max(margin, Math.min(x0, container.w - w - margin));
  const y = Math.max(margin, Math.min(r.y, container.h - h - margin));
  return { x, y, w, h };
}

/** The keyboard shortcut and edge tab both toggle between "visible" and "collapsed". */
export function toggled(mode: PanelMode, lastVisible: Exclude<PanelMode, "collapsed">): PanelMode {
  return mode === "collapsed" ? lastVisible : "collapsed";
}
