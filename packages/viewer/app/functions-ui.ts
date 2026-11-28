import type { GraphIndex } from "@buildrax/graph";
import type { FnEntry, FunctionsFile } from "@buildrax/ir";
import { h } from "./dom.js";

/** Function index lookups for the viewer (built once from the embedded side file). */
export interface FnIndex {
  byFile: Map<string, FnEntry[]>;
  byId: Map<string, { fn: FnEntry; path: string }>;
  byRoute: Map<string, { fn: FnEntry; path: string }[]>;
}

/** Accepts the embedded JSON only if it looks like a function index; anything else is ignored. */
export function readFnIndex(raw: unknown): FnIndex | undefined {
  const f = raw as FunctionsFile | undefined;
  if (!f || f.schemaVersion !== "buildrax-functions/v1" || !Array.isArray(f.files))
    return undefined;
  const idx: FnIndex = { byFile: new Map(), byId: new Map(), byRoute: new Map() };
  for (const file of f.files) {
    if (typeof file?.path !== "string" || !Array.isArray(file.functions)) continue;
    idx.byFile.set(file.path, file.functions);
    for (const fn of file.functions) {
      idx.byId.set(fn.id, { fn, path: file.path });
      for (const r of fn.routes ?? [])
        idx.byRoute.set(r, [...(idx.byRoute.get(r) ?? []), { fn, path: file.path }]);
    }
  }
  return idx;
}

export interface FnSectionCtx {
  fns: FnIndex;
  index: GraphIndex;
  /** Open the code at a line (floating window when source is available). */
  onOpen?: (path: string, line: number, label: string) => void;
  onSelectNode: (id: string) => void;
}

const fileOfId = (id: string): string => id.slice(3, id.lastIndexOf("#"));
const shortPath = (p: string): string => p.split("/").slice(-2).join("/");

function link(text: string, title: string, onClick: () => void): HTMLElement {
  const b = h("button", { type: "button", class: "link", title }, text);
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

function fnRef(ctx: FnSectionCtx, id: string, fromPath: string): HTMLElement {
  const hit = ctx.fns.byId.get(id);
  const name = id.slice(id.lastIndexOf("#") + 1);
  const where = fileOfId(id) === fromPath ? "" : ` · ${shortPath(fileOfId(id))}`;
  if (!hit) return h("span", null, `${name}${where}`);
  return link(`${hit.fn.name}${where}`, `${hit.path}:${hit.fn.line}`, () =>
    ctx.onOpen
      ? ctx.onOpen(hit.path, hit.fn.line, hit.fn.name)
      : ctx.onSelectNode(`file:${hit.path}`),
  );
}

function nodeRef(ctx: FnSectionCtx, id: string): HTMLElement {
  const n = ctx.index.node(id);
  if (!n) return h("span", null, id);
  return link(n.kind === "file" ? (n.path ?? n.name) : n.name, `Select ${n.name}`, () =>
    ctx.onSelectNode(id),
  );
}

/** Evidence details end with "in <function>"; redundant inside that function's own row. */
const stripFn = (detail: string, fn: string): string =>
  detail.endsWith(` in ${fn}`) ? detail.slice(0, -(fn.length + 4)) : detail;

const refName = (ctx: FnSectionCtx, id: string): string => {
  const n = ctx.index.node(id);
  return n?.kind === "file" && n.path ? shortPath(n.path) : (n?.name ?? id);
};

function fnDetails(ctx: FnSectionCtx, fn: FnEntry, path: string): HTMLElement {
  const badges: string[] = [];
  if (fn.routes?.length) badges.push("handler");
  if (fn.ops.length) badges.push(`${fn.ops.length} data`);
  if (fn.calledBy?.length)
    badges.push(`${fn.calledBy.length} caller${fn.calledBy.length > 1 ? "s" : ""}`);
  const rows: HTMLElement[] = [];
  const row = (label: string, ...kids: (Node | string)[]): void => {
    rows.push(h("li", null, h("span", { class: "fn-label" }, label), " ", ...kids));
  };
  for (const r of fn.routes ?? []) row("handles", nodeRef(ctx, r));
  for (const o of fn.ops)
    row(
      o.kind,
      nodeRef(ctx, o.to),
      h(
        "span",
        { class: "muted" },
        ` :${o.line}${o.detail ? ` ${stripFn(o.detail, fn.name)}` : ""}`,
      ),
    );
  for (const c of fn.calls)
    row(
      "calls",
      c.to?.startsWith("fn:")
        ? fnRef(ctx, c.to, path)
        : c.to
          ? link(`${c.name} → ${refName(ctx, c.to)}`, `Select ${c.to}`, () =>
              ctx.onSelectNode(c.to!),
            )
          : h("span", null, c.name),
      h("span", { class: "muted" }, ` ${c.via ?? ""}${c.count ? ` ×${c.count}` : ""}`),
    );
  for (const by of fn.calledBy ?? []) row("called by", fnRef(ctx, by, path));
  if (fn.otherCalls)
    rows.push(
      h("li", { class: "muted" }, `+${fn.otherCalls} other call(s): built-ins, parameters, locals`),
    );
  const open = ctx.onOpen
    ? link("Show code", `${path}:${fn.line}`, () => ctx.onOpen!(path, fn.line, fn.name))
    : null;
  return h(
    "details",
    { class: "fn-item" },
    h(
      "summary",
      null,
      h("span", { class: "fn-name" }, fn.name),
      h("span", { class: "muted" }, ` :${fn.line}`),
      ...badges.map((b) => h("span", { class: "fn-badge" }, b)),
    ),
    h("ul", { class: "fn-rows" }, ...rows),
    open,
  );
}

/**
 * Functions for the selected file (or the handler of a selected route). Collapsed until opened:
 * function-level detail is only for drilling in.
 */
export function renderFunctionsSection(ctx: FnSectionCtx, nodeId: string): HTMLElement | null {
  const n = ctx.index.node(nodeId);
  if (!n) return null;
  let list: { fn: FnEntry; path: string }[] = [];
  if (n.kind === "file" && n.path)
    list = (ctx.fns.byFile.get(n.path) ?? []).map((fn) => ({ fn, path: n.path! }));
  else if (n.kind === "route") list = ctx.fns.byRoute.get(nodeId) ?? [];
  if (!list.length) return null;
  const body = h("div", { class: "fn-list" });
  const box = h(
    "details",
    { class: "functions-section" },
    h(
      "summary",
      null,
      h("h3", null, n.kind === "route" ? "Handler" : `Functions (${list.length})`),
    ),
    body,
    h(
      "p",
      { class: "muted" },
      "Static: calls matched by name through imports; data operations are the proven ones.",
    ),
  );
  // Build rows only when opened (large files stay cheap to select).
  const fill = (): void => {
    if (body.childElementCount) return;
    for (const { fn, path } of list) body.append(fnDetails(ctx, fn, path));
  };
  if (n.kind === "route") {
    box.open = true;
    fill();
  } else box.addEventListener("toggle", fill);
  return box;
}
