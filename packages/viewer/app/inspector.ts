import type { GraphIndex, GraphView } from "@buildrax/graph";
import type { Evidence } from "@buildrax/ir";
import { h, put } from "./dom.js";

export interface InspectorCtx {
  index: GraphIndex;
  view: GraphView;
  selected?: { type: "node" | "edge"; id: string };
  expanded: ReadonlySet<string>;
  onSelectNode(id: string): void;
  onExpand(id: string): void;
  onCollapse(id: string): void;
  /** Enter (or leave) node view for a node. */
  onFocus(id: string): void;
  /** Node currently shown in node view, if any. */
  focusId?: string;
  cyclesFor(id: string): string[][];
}

const loc = (e: Evidence): string =>
  e.file ? `${e.file}${e.startLine ? `:${e.startLine}` : ""}` : (e.detail ?? "(no location)");

function copy(text: string): void {
  try {
    void navigator.clipboard?.writeText(text);
  } catch {
    /* clipboard unavailable: ignore */
  }
}

function evidenceList(items: readonly Evidence[]): HTMLElement {
  return h(
    "ul",
    { class: "evidence" },
    ...items.map((e) =>
      h(
        "li",
        null,
        h("span", { class: `badge ev-${e.kind}` }, e.kind),
        " ",
        h("code", null, loc(e)),
        e.detail && e.file ? h("div", { class: "muted" }, e.detail) : null,
        e.file ? h("button", { class: "link", type: "button" }, "copy") : null,
      ),
    ),
  );
}

function wireCopy(root: HTMLElement, items: readonly Evidence[]): void {
  const withFile = items.filter((e) => e.file);
  root.querySelectorAll("ul.evidence li button").forEach((b, i) => {
    const item = withFile[i];
    if (item) b.addEventListener("click", () => copy(loc(item)));
  });
}

function section(title: string, ...kids: (Node | string | null)[]): HTMLElement {
  return h("section", null, h("h3", null, title), ...kids);
}

function neighborList(ctx: InspectorCtx, id: string, dir: "in" | "out"): HTMLElement {
  const edges = ctx.view.edges.filter((e) => (dir === "out" ? e.from === id : e.to === id));
  if (!edges.length) return h("p", { class: "muted" }, "none");
  return h(
    "ul",
    { class: "neighbors" },
    ...edges.map((e) => {
      const other = dir === "out" ? e.to : e.from;
      const name = ctx.index.node(other)?.name ?? other;
      const b = h("button", { class: "link", type: "button" }, name);
      b.addEventListener("click", () => ctx.onSelectNode(other));
      return h("li", null, b, h("span", { class: "muted" }, ` ×${e.count}`));
    }),
  );
}

/** Render the right-hand inspector. Everything goes through text nodes (never innerHTML). */
export function renderInspector(root: HTMLElement, ctx: InspectorCtx): void {
  root.replaceChildren();
  const sel = ctx.selected;
  if (!sel) {
    put(
      root,
      h(
        "p",
        { class: "muted pad" },
        "Select a node or edge to inspect its evidence. Double-click a module to expand it.",
      ),
    );
    return;
  }
  if (sel.type === "edge") return renderEdgeInfo(root, ctx, sel.id);
  const node = ctx.index.node(sel.id);
  if (!node) return;

  const crumbs = ctx.index.ancestors(sel.id).reverse();
  put(
    root,
    h(
      "header",
      null,
      h("h2", null, node.name),
      h("div", { class: "muted" }, node.kind + (node.language ? ` · ${node.language}` : "")),
    ),
    crumbs.length
      ? h(
          "div",
          { class: "crumbs muted" },
          crumbs.map((c) => ctx.index.node(c)?.name ?? c).join(" › "),
        )
      : null,
    node.path ? section("Path", h("code", null, node.path)) : null,
  );

  const cycles = ctx.cyclesFor(sel.id);
  if (cycles.length) {
    put(
      root,
      section(
        "Circular dependency",
        ...cycles.map((c) =>
          h("p", { class: "warn" }, c.map((f) => ctx.index.node(f)?.name ?? f).join(" ↔ ")),
        ),
      ),
    );
  }

  const actions = h("div", { class: "actions" });
  const inFocus = ctx.focusId === sel.id;
  const focusBtn = h(
    "button",
    { type: "button", class: "primary", title: "Show only this node and what connects to it (F)" },
    inFocus ? "Exit node view" : "Open node view",
  );
  focusBtn.addEventListener("click", () => ctx.onFocus(sel.id));
  actions.append(focusBtn);
  const viewNode = ctx.view.nodes.find((n) => n.id === sel.id);
  if (viewNode?.expandable) {
    const b = h("button", { type: "button" }, "Expand");
    b.addEventListener("click", () => ctx.onExpand(sel.id));
    actions.append(b);
  }
  if (node.parent && ctx.expanded.has(node.parent)) {
    const b = h(
      "button",
      { type: "button" },
      `Collapse ${ctx.index.node(node.parent)?.name ?? "parent"}`,
    );
    b.addEventListener("click", () => ctx.onCollapse(node.parent!));
    actions.append(b);
  }
  if (actions.childNodes.length) put(root, actions);

  const evSection = section("Evidence", evidenceList(node.evidence));
  wireCopy(evSection, node.evidence);
  put(
    root,
    evSection,
    section("Depends on (visible)", neighborList(ctx, sel.id, "out")),
    section("Used by (visible)", neighborList(ctx, sel.id, "in")),
    section(
      "Connectivity",
      h(
        "p",
        { class: "muted" },
        `fan-in ${ctx.index.fanIn(sel.id)} · fan-out ${ctx.index.fanOut(sel.id)} (direct, file level)`,
      ),
    ),
  );
}

function renderEdgeInfo(root: HTMLElement, ctx: InspectorCtx, id: string): void {
  const e = ctx.view.edges.find((x) => x.id === id);
  if (!e) return;
  const name = (nid: string): string => ctx.index.node(nid)?.name ?? nid;
  const from = h("button", { class: "link", type: "button" }, name(e.from));
  const to = h("button", { class: "link", type: "button" }, name(e.to));
  from.addEventListener("click", () => ctx.onSelectNode(e.from));
  to.addEventListener("click", () => ctx.onSelectNode(e.to));
  const evSection = section(
    `Evidence (showing ${e.evidence.length} of ${e.count})`,
    evidenceList(e.evidence),
  );
  wireCopy(evSection, e.evidence);
  put(
    root,
    h(
      "header",
      null,
      h("h2", null, "Dependency"),
      h("div", { class: "muted" }, e.kinds.join(", ")),
    ),
    h("p", null, from, " → ", to),
    e.inCycle ? h("p", { class: "warn" }, "Part of a circular dependency at this level.") : null,
    evSection,
  );
}
