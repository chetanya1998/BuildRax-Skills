import type { GraphIndex } from "@buildrax/graph";
import { isInfraKind } from "./groups.js";

export type ColorMode = "package" | "kind" | "language" | "heat";
export const COLOR_MODES: readonly ColorMode[] = ["package", "kind", "language", "heat"];

/** Hand-picked, well separated hues (degrees). Packages get these in order, so neighbours differ. */
export const PACKAGE_HUES = [212, 162, 32, 292, 346, 52, 188, 126, 258, 8, 84, 318] as const;

const KIND_HUE: Record<string, number> = {
  project: 276,
  module: 232,
  file: 198,
  external: 36,
  unresolved: 4,
  class: 160,
  function: 140,
  route: 320,
  entity: 110,
  service: 250,
  database: 100,
  compute: 190,
  hosting: 172,
  cache: 8,
  queue: 52,
  storage: 30,
  cdn: 300,
  email: 330,
  payments: 140,
  llm: 282,
  messaging: 64,
  search: 226,
  auth: 350,
};

const LANG_HUE: Record<string, number> = { typescript: 212, javascript: 48, python: 148 };

const HEAT_LABELS = ["quiet", "some links", "busy", "very connected", "hub"] as const;

export interface Colored {
  id: string;
  kind: string;
  language?: string;
}

export interface ColorCtx {
  index: GraphIndex;
  /** Largest fan-in + fan-out in the graph, for the heat scale. */
  maxDegree: number;
}

/** Top-level package (module with package meta) that contains a node, or its own id. */
export function packageOf(index: GraphIndex, id: string): string | undefined {
  const own = index.node(id);
  if (own?.kind === "module" && own.meta?.package) return id;
  for (const a of index.ancestors(id)) {
    const n = index.node(a);
    if (n?.kind === "module" && n.meta?.package) return a;
  }
  return undefined;
}

/** Stable package -> hue assignment (sorted by id so it never depends on scan order). */
export function packageHues(index: GraphIndex): Map<string, number> {
  const pkgs = index.model.nodes
    .filter((n) => n.kind === "module" && n.meta?.package)
    .map((n) => n.id)
    .sort();
  return new Map(pkgs.map((id, i) => [id, PACKAGE_HUES[i % PACKAGE_HUES.length]!]));
}

export interface Swatch {
  /** Hue 0-360 (used as `--h`; the CSS decides lightness per theme). */
  hue: number;
  /** Saturation 0-100. */
  sat: number;
  key: string;
  label: string;
}

/** Color for a node in the chosen mode. Lightness is left to CSS so both themes look right. */
export function swatchFor(
  n: Colored,
  mode: ColorMode,
  ctx: ColorCtx,
  hues: Map<string, number>,
): Swatch {
  if (mode === "heat") {
    const deg = ctx.index.fanIn(n.id) + ctx.index.fanOut(n.id);
    // sqrt spreads the colors out: a handful of hubs would otherwise make everything else look the same.
    const t = ctx.maxDegree > 0 ? Math.min(1, Math.sqrt(deg / ctx.maxDegree)) : 0;
    const bucket = Math.min(4, Math.floor(t * 5));
    const hue = Math.round(190 + t * 150); // cyan -> magenta
    return { hue, sat: 82, key: `heat:${bucket}`, label: HEAT_LABELS[bucket]! };
  }
  if (mode === "language") {
    if (n.language)
      return {
        hue: LANG_HUE[n.language] ?? 215,
        sat: 78,
        key: `lang:${n.language}`,
        label: n.language,
      };
    return {
      hue: KIND_HUE[n.kind] ?? 215,
      sat: n.kind === "external" || n.kind === "unresolved" ? 78 : 30,
      key: `kind:${n.kind}`,
      label: n.kind === "module" ? "package / folder" : n.kind,
    };
  }
  if (mode === "kind") {
    return {
      hue: KIND_HUE[n.kind] ?? 215,
      sat: 78,
      key: `kind:${n.kind}`,
      label: n.kind === "module" ? "package / folder" : n.kind,
    };
  }
  if (n.kind === "external")
    return { hue: KIND_HUE.external!, sat: 80, key: "kind:external", label: "external dependency" };
  if (n.kind === "unresolved")
    return {
      hue: KIND_HUE.unresolved!,
      sat: 85,
      key: "kind:unresolved",
      label: "unresolved import",
    };
  if (isInfraKind(n.kind))
    return { hue: KIND_HUE[n.kind] ?? 190, sat: 70, key: "kind:infra", label: "infrastructure" };
  const pkg = packageOf(ctx.index, n.id);
  if (!pkg) return { hue: 215, sat: 25, key: "pkg:-", label: "repository" };
  return {
    hue: hues.get(pkg) ?? 215,
    sat: 74,
    key: `pkg:${pkg}`,
    label: ctx.index.node(pkg)?.name ?? pkg,
  };
}

export interface LegendEntry {
  key: string;
  label: string;
  hue: number;
  sat: number;
  count: number;
}

/** Legend for the nodes currently on screen. */
export function legendFor(
  nodes: readonly Colored[],
  mode: ColorMode,
  ctx: ColorCtx,
  hues: Map<string, number>,
): LegendEntry[] {
  const out = new Map<string, LegendEntry>();
  for (const n of nodes) {
    const s = swatchFor(n, mode, ctx, hues);
    const cur = out.get(s.key);
    if (cur) cur.count++;
    else out.set(s.key, { key: s.key, label: s.label, hue: s.hue, sat: s.sat, count: 1 });
  }
  const rank = (e: LegendEntry): number => (e.key.startsWith("heat:") ? Number(e.key.slice(5)) : 0);
  return [...out.values()].sort(
    (a, b) => rank(a) - rank(b) || b.count - a.count || (a.label < b.label ? -1 : 1),
  );
}
