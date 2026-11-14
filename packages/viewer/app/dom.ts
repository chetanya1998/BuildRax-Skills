type Attrs = Record<string, string | number | undefined> | null;

/** Build an HTML element. String children become text nodes, so repo text is never parsed as HTML. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = null,
  ...kids: (Node | string | null | undefined)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  apply(el, attrs, kids);
  return el;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** Build an SVG element (same text-safety guarantees as h). */
export function s<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Attrs = null,
  ...kids: (Node | string | null | undefined)[]
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  apply(el, attrs, kids);
  return el;
}

function apply(el: Element, attrs: Attrs, kids: (Node | string | null | undefined)[]): void {
  if (attrs)
    for (const [k, v] of Object.entries(attrs)) if (v !== undefined) el.setAttribute(k, String(v));
  for (const k of kids)
    if (k !== null && k !== undefined)
      el.append(typeof k === "string" ? document.createTextNode(k) : k);
}

/** Append children to an existing element, skipping null/undefined. */
export function put(el: Element, ...kids: (Node | string | null | undefined)[]): void {
  apply(el, null, kids);
}
