import type { GraphIndex } from "@buildrax/graph";
import type { Evidence } from "@buildrax/ir";
import { connectionsFor, excerptRange, type Link } from "./code-logic.js";
import type { CodeSource } from "./code-source.js";
import { h, put } from "./dom.js";
import { tokenizeFile } from "./highlight.js";

export interface CodeCtx {
  index: GraphIndex;
  source: CodeSource;
  selected?: { type: "node" | "edge"; id: string };
  /** Aggregated edge currently drawn on the canvas (for edge selection). */
  edge(id: string): { from: string; to: string; evidence: Evidence[]; count: number } | undefined;
  onSelectNode(id: string): void;
}

interface BlockOpts {
  path: string;
  text: string;
  language?: string;
  /** line -> label shown at the end of the line (e.g. "imports billing.ts"). */
  marks?: Map<number, string>;
  range?: { start: number; end: number };
  /** Cap for full-file blocks; the rest is behind a "show all" button. */
  maxLines?: number;
  /** Shown line numbers start after this many lines (for excerpts of a larger file). */
  lineOffset?: number;
  /** Header text instead of the default "path (N lines)". */
  title?: string;
}

const loc = (e: Evidence): string =>
  e.file ? `${e.file}${e.startLine ? `:${e.startLine}` : ""}` : (e.detail ?? "");

/** A read-only code listing with line numbers, highlighted lines and syntax colors. Text nodes only. */
export function codeBlock(o: BlockOpts): HTMLElement {
  const lines = tokenizeFile(o.text, o.language);
  const total = lines.length;
  const range = o.range ?? { start: 1, end: Math.min(total, o.maxLines ?? 400) };
  const body = h("div", { class: "cb-body", role: "region", "aria-label": `Code of ${o.path}` });
  const draw = (start: number, end: number): void => {
    body.replaceChildren();
    for (let n = start; n <= end; n++) {
      const mark = o.marks?.get(n);
      const row = h(
        "div",
        { class: `row${mark ? " mark" : ""}` },
        h("span", { class: "ln" }, String(n + (o.lineOffset ?? 0))),
        h(
          "span",
          { class: "src" },
          ...(lines[n - 1] ?? []).map((t) =>
            t.k === "plain" ? t.v : h("span", { class: `tk-${t.k}` }, t.v),
          ),
          "​",
        ),
        mark ? h("span", { class: "mk" }, mark) : null,
      );
      body.append(row);
    }
    if (end < total && !o.range) {
      const more = h("button", { type: "button", class: "link" }, `Show all ${total} lines`);
      more.addEventListener("click", () => draw(1, total));
      body.append(h("div", { class: "more" }, more));
    }
  };
  draw(range.start, range.end);
  const label =
    o.title ??
    (o.range
      ? `${o.path}:${range.start}-${range.end}`
      : `${o.path} (${total} line${total === 1 ? "" : "s"})`);
  const block = h("div", { class: "codeblock" }, h("div", { class: "cb-head" }, label), body);
  // Bring the first highlighted line into view once the block is attached.
  queueMicrotask(() => {
    const first = body.querySelector<HTMLElement>(".row.mark");
    if (first) body.scrollTop = Math.max(0, first.offsetTop - 48);
  });
  return block;
}

function note(text: string): HTMLElement {
  return h("p", { class: "muted" }, text);
}

function missing(source: CodeSource, path: string): HTMLElement {
  return note(
    source.mode === "none"
      ? "No source is embedded in this file. Run `buildrax view` without --no-source, or use `buildrax serve`."
      : `Source for ${path} is not available (not a scanned source file, or too large).`,
  );
}

/** Placeholder that fills itself once the file text is available. */
function lazyBlock(
  ctx: CodeCtx,
  alive: () => boolean,
  path: string,
  make: (text: string) => HTMLElement,
): HTMLElement {
  const box = h("div", { class: "lazy" }, note("loading…"));
  void ctx.source.get(path).then((text) => {
    if (!alive()) return;
    box.replaceChildren(text === undefined ? missing(ctx.source, path) : make(text));
  });
  return box;
}

function toggle(label: string, build: () => HTMLElement): HTMLElement {
  const slot = h("div", { class: "toggle-slot" });
  const btn = h("button", { type: "button", class: "link" }, label);
  let open = false;
  btn.addEventListener("click", () => {
    open = !open;
    slot.replaceChildren(...(open ? [build()] : []));
    btn.textContent = open ? `Hide ${label.replace(/^Show /, "")}` : label;
  });
  return h("div", null, btn, slot);
}

function card(ctx: CodeCtx, alive: () => boolean, link: Link, dir: "down" | "up"): HTMLElement {
  const other = ctx.index.node(link.other);
  const name = other?.path ?? other?.name ?? link.other;
  const head = h(
    "button",
    { type: "button", class: "card-head" },
    h("strong", null, name),
    ` `,
    h("span", { class: "badge" }, other?.kind ?? "node"),
    link.count > 1 ? h("span", { class: "muted" }, ` ×${link.count}`) : null,
  );
  head.addEventListener("click", () => ctx.onSelectNode(link.other));
  const c = h("div", { class: `card ${dir}` }, head);
  for (const ev of link.evidence) {
    if (!ev.file || !ev.startLine) continue;
    const line = ev.startLine;
    const file = ev.file;
    c.append(
      h(
        "div",
        { class: "muted anchor" },
        `${dir === "down" ? "used at" : "used there at"} ${loc(ev)}${ev.kind === "unresolved" ? " (unresolved)" : ""}`,
      ),
      lazyBlock(ctx, alive, file, (text) => {
        const total = text.split("\n").length;
        return codeBlock({
          path: file,
          text,
          language: ctx.index.node(`file:${file}`)?.language,
          range: excerptRange(total, line, 3),
          marks: new Map([[line, dir === "down" ? `→ ${other?.name ?? ""}` : "← uses this"]]),
        });
      }),
    );
  }
  if (other?.kind === "file" && other.path) {
    const p = other.path;
    c.append(
      toggle(`Show code of ${other.name}`, () =>
        lazyBlock(ctx, alive, p, (text) =>
          codeBlock({ path: p, text, language: other.language, maxLines: 200 }),
        ),
      ),
    );
  }
  return c;
}

function section(title: string, ...kids: (Node | string | null)[]): HTMLElement {
  return h("section", null, h("h3", null, title), ...kids);
}

/** Render the Code tab for the current selection. `alive` lets callers cancel stale renders. */
export function renderCodePanel(root: HTMLElement, ctx: CodeCtx, alive: () => boolean): void {
  root.replaceChildren();
  const sel = ctx.selected;
  if (!sel) {
    put(
      root,
      note(
        "Select a node to read its code and the files connected to it. Upstream and downstream files are highlighted on the graph.",
      ),
    );
    return;
  }

  if (sel.type === "edge") {
    const e = ctx.edge(sel.id);
    if (!e) return;
    const nm = (id: string): string => ctx.index.node(id)?.name ?? id;
    put(
      root,
      h(
        "header",
        null,
        h("h2", null, `${nm(e.from)} → ${nm(e.to)}`),
        h("div", { class: "muted" }, `${e.count} underlying import${e.count === 1 ? "" : "s"}`),
      ),
    );
    for (const ev of e.evidence) {
      if (!ev.file || !ev.startLine) continue;
      const line = ev.startLine;
      const file = ev.file;
      put(
        root,
        section(
          loc(ev),
          lazyBlock(ctx, alive, file, (text) =>
            codeBlock({
              path: file,
              text,
              language: ctx.index.node(`file:${file}`)?.language,
              range: excerptRange(text.split("\n").length, line, 5),
              marks: new Map([[line, "this import"]]),
            }),
          ),
        ),
      );
    }
    return;
  }

  const node = ctx.index.node(sel.id);
  if (!node) return;
  const conns = connectionsFor(ctx.index, sel.id);
  put(
    root,
    h(
      "header",
      null,
      h("h2", null, node.name),
      h(
        "div",
        { class: "muted" },
        `${node.kind}${node.language ? ` · ${node.language}` : ""}${node.path ? ` · ${node.path}` : ""}`,
      ),
    ),
  );

  if (node.kind === "file" && node.path) {
    const path = node.path;
    const marks = new Map<number, string>();
    for (const l of conns.down) {
      for (const ev of l.evidence) {
        if (ev.file === path && ev.startLine)
          marks.set(ev.startLine, `→ ${ctx.index.node(l.other)?.name ?? l.other}`);
      }
    }
    put(
      root,
      section(
        "This file",
        lazyBlock(ctx, alive, path, (text) =>
          codeBlock({ path, text, language: node.language, marks }),
        ),
      ),
    );
  } else if (conns.files.length) {
    const list = h("ul", { class: "neighbors" });
    for (const f of conns.files.slice(0, 40)) {
      const b = h("button", { type: "button", class: "link" }, ctx.index.node(f)?.path ?? f);
      b.addEventListener("click", () => ctx.onSelectNode(f));
      list.append(h("li", null, b));
    }
    put(
      root,
      section(
        `Files inside (${conns.files.length})`,
        list,
        conns.files.length > 40 ? note(`+${conns.files.length - 40} more`) : null,
      ),
    );
  } else {
    put(root, note("This node has no source file of its own. Its connections are listed below."));
  }

  const cap = 12;
  const group = (title: string, links: Link[], dir: "down" | "up"): HTMLElement =>
    section(
      `${title} (${links.length})`,
      links.length
        ? h("div", { class: "cards" }, ...links.slice(0, cap).map((l) => card(ctx, alive, l, dir)))
        : note("none"),
      links.length > cap ? note(`+${links.length - cap} more (select them on the graph)`) : null,
    );
  put(
    root,
    group("Uses (downstream)", conns.down, "down"),
    group("Used by (upstream)", conns.up, "up"),
  );
}
