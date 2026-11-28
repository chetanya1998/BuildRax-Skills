import type { GraphIndex } from "@buildrax/graph";
import type { RationaleFile, RationaleSource } from "@buildrax/ir";
import { h } from "./dom.js";

/** Accepts the embedded JSON only if it looks like a rationale index; anything else is ignored. */
export function readRationale(raw: unknown): RationaleFile | undefined {
  const r = raw as RationaleFile | undefined;
  if (
    !r ||
    r.schemaVersion !== "buildrax-rationale/v1" ||
    !Array.isArray(r.sources) ||
    typeof r.byNode !== "object" ||
    r.byNode === null
  )
    return undefined;
  return r;
}

const LABEL: Record<RationaleSource["kind"], string> = {
  adr: "Decision record",
  doc: "Documented",
  comment: "From code",
  commit: "From git history",
};

export interface WhyCtx {
  rationale: RationaleFile;
  index: GraphIndex;
  /** Open a repo file at a line (code window), when source is available. */
  onOpen?: (path: string, line: number, label: string) => void;
}

/** Sources tied to a node directly, then a count of those tied to files inside it. */
export function whyFor(
  r: RationaleFile,
  index: GraphIndex,
  nodeId: string,
): { sources: RationaleSource[]; inside: number } {
  const byId = new Map(r.sources.map((s) => [s.id, s] as const));
  const sources = (r.byNode[nodeId] ?? [])
    .map((id) => byId.get(id))
    .filter((s): s is RationaleSource => !!s);
  const own = new Set(sources.map((s) => s.id));
  const inside = new Set<string>();
  for (const d of index.descendants(nodeId))
    for (const id of r.byNode[d] ?? []) if (!own.has(id)) inside.add(id);
  return { sources, inside: inside.size };
}

function item(ctx: WhyCtx, s: RationaleSource): HTMLElement {
  const meta = [
    s.kind === "adr" ? s.status : undefined,
    s.date,
    s.hash,
    s.file ? `${s.file}${s.line && s.line > 1 ? `:${s.line}` : ""}` : undefined,
  ].filter(Boolean);
  const open =
    ctx.onOpen && s.kind === "comment" && s.file && s.line
      ? h("button", { type: "button", class: "link" }, "Show code")
      : null;
  open?.addEventListener("click", () => ctx.onOpen!(s.file!, s.line!, s.title));
  return h(
    "li",
    { class: `why-item why-${s.kind}` },
    h(
      "div",
      { class: "why-head" },
      h("span", { class: "why-label" }, LABEL[s.kind]),
      " ",
      h("strong", null, s.kind === "comment" && !s.fn ? "" : s.title),
    ),
    h("p", { class: "why-text" }, s.kind === "comment" ? `“${s.excerpt}”` : s.excerpt),
    h("div", { class: "muted why-meta" }, meta.join(" · ")),
    open,
  );
}

/** "Why" in the inspector: quoted rationale tied to the selected node, labelled by where it is from. */
export function renderWhySection(ctx: WhyCtx, nodeId: string): HTMLElement | null {
  const { sources, inside } = whyFor(ctx.rationale, ctx.index, nodeId);
  if (!sources.length && !inside) return null;
  return h(
    "section",
    { class: "why-section" },
    h("h3", null, `Why (${sources.length})`),
    sources.length ? h("ul", { class: "why-list" }, ...sources.map((s) => item(ctx, s))) : null,
    inside
      ? h(
          "p",
          { class: "muted" },
          `+${inside} more tied to files inside it. Select one to see them.`,
        )
      : null,
    h(
      "p",
      { class: "muted" },
      "Quoted from decision records, docs, comments and commit messages, tied by exact names and paths. Not verified against the code.",
    ),
  );
}
