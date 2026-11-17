import { h } from "./dom.js";

export type Inline =
  | { t: "text"; v: string }
  | { t: "bold" | "italic" | "code"; v: string }
  | { t: "link"; v: string; href: string };

export type Block = { t: "p"; inline: Inline[] } | { t: "ul"; items: Inline[][] };

const INLINE = /(\*\*[^*\n]+\*\*|\*[^*\n]+\*|`[^`\n]+`|\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))/g;

/** Parse the small markdown subset. Only http(s) links are recognised; everything else is text. */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    const tok = m[0];
    const at = m.index ?? 0;
    if (at > last) out.push({ t: "text", v: text.slice(last, at) });
    if (tok.startsWith("**")) out.push({ t: "bold", v: tok.slice(2, -2) });
    else if (tok.startsWith("`")) out.push({ t: "code", v: tok.slice(1, -1) });
    else if (tok.startsWith("[")) {
      const close = tok.indexOf("](");
      out.push({ t: "link", v: tok.slice(1, close), href: tok.slice(close + 2, -1) });
    } else out.push({ t: "italic", v: tok.slice(1, -1) });
    last = at + tok.length;
  }
  if (last < text.length) out.push({ t: "text", v: text.slice(last) });
  return out;
}

export function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  let list: Inline[][] | undefined;
  for (const line of text.split("\n")) {
    const item = /^\s*[-*]\s+(.*)$/.exec(line);
    if (item) {
      if (!list) {
        list = [];
        blocks.push({ t: "ul", items: list });
      }
      list.push(parseInline(item[1]!));
      continue;
    }
    list = undefined;
    if (line.trim()) blocks.push({ t: "p", inline: parseInline(line) });
  }
  return blocks;
}

function renderInline(parts: Inline[]): (Node | string)[] {
  return parts.map((p) => {
    switch (p.t) {
      case "text":
        return p.v;
      case "bold":
        return h("strong", null, p.v);
      case "italic":
        return h("em", null, p.v);
      case "code":
        return h("code", null, p.v);
      case "link":
        return h("a", { href: p.href, target: "_blank", rel: "noopener noreferrer" }, p.v);
    }
  });
}

/** Render note text to DOM nodes. All text goes through text nodes: no HTML is ever parsed. */
export function renderMarkdown(text: string): HTMLElement {
  return h(
    "div",
    { class: "md" },
    ...parseBlocks(text).map((b) =>
      b.t === "p"
        ? h("p", null, ...renderInline(b.inline))
        : h("ul", null, ...b.items.map((i) => h("li", null, ...renderInline(i)))),
    ),
  );
}
