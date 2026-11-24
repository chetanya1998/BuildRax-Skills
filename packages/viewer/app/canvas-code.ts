import type { GraphIndex, GraphView } from "@buildrax/graph";
import type { Evidence } from "@buildrax/ir";
import type { TraceStep } from "./trace.js";

/**
 * What the floating code window shows. Pure data, decided per selection, shared by the Graph,
 * Nodes and Flows views (and unit-tested without a browser).
 */
export type CodeSection =
  /** A whole file, scrolled to `focus`, with the lines that matter marked. */
  | { kind: "file"; file: string; marks: [number, string][]; focus?: number; label?: string }
  /** A few lines around `line` in a file. `config` = a deploy/config file (excerpt is redacted). */
  | { kind: "excerpt"; file: string; line: number; mark: string; label?: string; config?: boolean }
  /** A list of files to open (packages and folders). */
  | { kind: "files"; files: { path: string; lines?: number }[]; label?: string };

export interface CodeView {
  title: string;
  /** Node "Show in graph" selects. */
  nodeId?: string;
  sections: CodeSection[];
  /** Shown above the sections, e.g. "+12 more places". */
  note?: string;
}

/** Most excerpts shown at once; the rest is summarised. */
export const MAX_SECTIONS = 12;

const nameOf = (index: GraphIndex, id: string): string => {
  const n = index.node(id);
  return n?.kind === "file" ? n.name : (n?.name ?? id);
};
const isCode = (index: GraphIndex, file: string): boolean =>
  index.node(`file:${file}`)?.kind === "file";

/** One label per line (a line can create several links). */
export function mergeMarks(marks: [number, string][]): [number, string][] {
  const by = new Map<number, string[]>();
  for (const [line, label] of marks) {
    const list = by.get(line) ?? [];
    if (!list.includes(label)) list.push(label);
    by.set(line, list);
  }
  return [...by.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([l, labels]) => [l, labels.join(" · ")]);
}

/** Excerpts for a set of evidence anchors, de-duplicated and capped. */
function excerpts(
  index: GraphIndex,
  items: { ev: Evidence; mark: string; label?: string }[],
): { sections: CodeSection[]; more: number } {
  const seen = new Set<string>();
  const out: CodeSection[] = [];
  for (const { ev, mark, label } of items) {
    if (!ev.file || !ev.startLine) continue;
    const key = `${ev.file}:${ev.startLine}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      kind: "excerpt",
      file: ev.file,
      line: ev.startLine,
      mark,
      ...(label ? { label } : {}),
      ...(isCode(index, ev.file) ? {} : { config: true }),
    });
  }
  out.sort((a, b) => {
    const x = a as Extract<CodeSection, { kind: "excerpt" }>;
    const y = b as Extract<CodeSection, { kind: "excerpt" }>;
    return x.file === y.file ? x.line - y.line : x.file < y.file ? -1 : 1;
  });
  return { sections: out.slice(0, MAX_SECTIONS), more: Math.max(0, out.length - MAX_SECTIONS) };
}

const verb = (kind: string, to: string): string =>
  kind === "uses"
    ? `uses ${to}`
    : kind === "imports" || kind === "depends-on"
      ? `imports ${to}`
      : `→ ${to}`;

/** A file: the whole file, with every line that links somewhere marked. */
export function fileView(index: GraphIndex, fileId: string): CodeView | undefined {
  const n = index.node(fileId);
  if (n?.kind !== "file" || !n.path) return undefined;
  const marks: [number, string][] = [];
  for (const e of index.out(fileId))
    for (const ev of e.evidence)
      if (ev.file === n.path && ev.startLine)
        marks.push([ev.startLine, verb(e.kind, nameOf(index, e.to))]);
  // Endpoints defined here.
  for (const c of index.children(fileId)) {
    const r = index.node(c);
    const line = r?.evidence[0]?.startLine;
    if (r?.kind === "route" && line) marks.push([line, r.name]);
  }
  const merged = mergeMarks(marks);
  // Who uses this file: their import lines, as excerpts below the file.
  const used = excerpts(
    index,
    [...index.in(fileId)]
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .flatMap((e) => e.evidence.map((ev) => ({ ev, mark: `imports ${n.name}` }))),
  );
  const usedSections: CodeSection[] = used.sections.map((sec, i) =>
    i === 0 ? { ...sec, label: "Used by" } : sec,
  );
  return {
    title: n.path,
    nodeId: fileId,
    sections: [
      { kind: "file", file: n.path, marks: merged, ...(merged[0] ? { focus: merged[0][0] } : {}) },
      ...usedSections,
    ],
    ...(used.more
      ? {
          note: `Used in ${used.sections.length + used.more} places; showing ${used.sections.length}.`,
        }
      : {}),
  };
}

/** Everything inside a package or folder, as a file list. */
function containerView(index: GraphIndex, id: string): CodeView {
  const n = index.node(id)!;
  const files = index
    .descendants(id)
    .map((d) => index.node(d))
    .filter((d): d is NonNullable<typeof d> => d?.kind === "file" && !!d.path)
    .map((d) => ({
      path: d.path!,
      lines: typeof d.meta?.["lines"] === "number" ? (d.meta["lines"] as number) : undefined,
    }))
    .sort((a, b) => (a.path < b.path ? -1 : 1));
  return {
    title: `${n.name} (${files.length} file${files.length === 1 ? "" : "s"})`,
    nodeId: id,
    sections: [{ kind: "files", files, label: n.path ?? n.name }],
  };
}

/**
 * Where something outside the code is used or declared: every import of an external package,
 * every SDK use of a database or queue, plus its declarations in deploy/config files.
 */
function usageView(index: GraphIndex, id: string): CodeView {
  const n = index.node(id)!;
  const items: { ev: Evidence; mark: string; label?: string }[] = [];
  for (const e of [...index.in(id)].sort((a, b) => (a.id < b.id ? -1 : 1)))
    for (const ev of e.evidence)
      items.push({ ev, mark: verb(e.kind === "uses" ? "uses" : "imports", n.name) });
  for (const ev of n.evidence)
    if (ev.kind === "config" && ev.file)
      items.push({ ev, mark: ev.detail ?? "declared here", label: "declared in" });
  const { sections, more } = excerpts(index, items);
  return {
    title: `${n.name} · ${n.kind}`,
    nodeId: id,
    sections,
    note: sections.length
      ? `${sections.length} place${sections.length === 1 ? "" : "s"}${more ? ` (+${more} more)` : ""}`
      : "No source location recorded for this node.",
  };
}

/** A link on the canvas: the lines that create it (aggregated links can have many). */
export function edgeView(index: GraphIndex, view: GraphView, edgeId: string): CodeView | undefined {
  const e = view.edges.find((x) => x.id === edgeId);
  if (!e) return undefined;
  const to = nameOf(index, e.to);
  const { sections, more } = excerpts(
    index,
    e.evidence.map((ev) => ({ ev, mark: `→ ${to}` })),
  );
  return {
    title: `${nameOf(index, e.from)} → ${to}`,
    nodeId: e.to,
    sections,
    note: `${e.count} link${e.count === 1 ? "" : "s"}${more ? ` · showing ${sections.length}` : ""}`,
  };
}

/** The current step of the Inspector's trace: the lines behind each link in that hop. */
export function traceStepView(index: GraphIndex, step: TraceStep): CodeView {
  const items = step.links
    .filter((l) => l.evidence)
    .map((l) => ({ ev: l.evidence!, mark: `${nameOf(index, l.from)} → ${nameOf(index, l.to)}` }));
  const { sections, more } = excerpts(index, items);
  return {
    title: `Trace step ${step.n} · ${step.direction === "downstream" ? "uses" : "used by"}`,
    nodeId: step.links[0]
      ? step.direction === "downstream"
        ? step.links[0].to
        : step.links[0].from
      : undefined,
    sections,
    note: `${step.links.length} link${step.links.length === 1 ? "" : "s"} in this step${more ? ` (+${more} more)` : ""}`,
  };
}

/** What a click on the canvas shows, by what was selected. */
export function selectionView(
  index: GraphIndex,
  view: GraphView,
  sel: { type: "node" | "edge"; id: string },
): CodeView | undefined {
  if (sel.type === "edge") return edgeView(index, view, sel.id);
  const n = index.node(sel.id);
  if (!n) return undefined;
  if (n.kind === "file") return fileView(index, n.id);
  if (n.kind === "route") {
    const ev = n.evidence[0];
    if (!ev?.file || !ev.startLine) return n.parent ? fileView(index, n.parent) : undefined;
    return {
      title: n.name,
      nodeId: n.parent,
      sections: [
        { kind: "file", file: ev.file, marks: [[ev.startLine, n.name]], focus: ev.startLine },
      ],
    };
  }
  if (n.kind === "module" || n.kind === "project") return containerView(index, n.id);
  return usageView(index, n.id);
}
