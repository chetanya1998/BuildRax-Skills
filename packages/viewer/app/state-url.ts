export type ThemeChoice = "auto" | "light" | "dark";

export interface ViewState {
  expanded: string[];
  selected?: { type: "node" | "edge"; id: string };
  /** Lineage depth; 0 means unlimited. */
  depth: number;
  showExternal: boolean;
  showUnresolved: boolean;
  theme: ThemeChoice;
  /** Which right-hand tab is open. */
  panel: "inspector" | "code";
}

export const DEFAULT_STATE: ViewState = {
  expanded: [],
  depth: 0,
  showExternal: true,
  showUnresolved: true,
  theme: "auto",
  panel: "inspector",
};

/** Serialize view state into a URL-hash-safe string. */
export function encodeState(s: ViewState): string {
  return encodeURIComponent(JSON.stringify(s));
}

/** Parse a hash produced by encodeState. Unknown or malformed input falls back to defaults. */
export function decodeState(hash: string): ViewState {
  const raw = hash.replace(/^#/, "");
  if (!raw) return { ...DEFAULT_STATE };
  try {
    const v = JSON.parse(decodeURIComponent(raw)) as Partial<ViewState>;
    const sel = v.selected;
    return {
      expanded: Array.isArray(v.expanded)
        ? v.expanded.filter((x): x is string => typeof x === "string")
        : [],
      selected:
        sel && (sel.type === "node" || sel.type === "edge") && typeof sel.id === "string"
          ? { type: sel.type, id: sel.id }
          : undefined,
      depth: typeof v.depth === "number" && v.depth >= 0 ? Math.floor(v.depth) : 0,
      showExternal: v.showExternal !== false,
      showUnresolved: v.showUnresolved !== false,
      theme: v.theme === "light" || v.theme === "dark" ? v.theme : "auto",
      panel: v.panel === "code" ? "code" : "inspector",
    };
  } catch {
    return { ...DEFAULT_STATE };
  }
}
