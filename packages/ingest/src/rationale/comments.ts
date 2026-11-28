import type { Node } from "web-tree-sitter";

/** A code comment that explains a choice ("because", "to avoid", "instead of", NOTE/HACK…). */
export interface RawWhy {
  line: number;
  endLine: number;
  text: string;
}

const MAX_PER_FILE = 30;
const MAX_TEXT = 400;

/** Wording that signals a reason, not a description. Matched case-insensitively on whole words. */
export const WHY_PATTERN =
  /\b(because|so that|in order to|to avoid|to prevent|to keep|instead of|rather than|trade-?offs?|workaround|work around|intentional(?:ly)?|deliberate(?:ly)?|on purpose|we (?:chose|choose|use|don't|do not|never|always|need)|why|otherwise|never|must not|do not change|important|note|hack|xxx|caveat)\b/i;

const NOISE =
  /\b(copyright|licen[sc]ed?|spdx-license|@ts-(?:ignore|expect-error|nocheck)|eslint-disable(?:-next-line|-line)?\s+[\w/@-]+\s*$|prettier-ignore|noqa|type:\s*ignore|pragma)\b/i;

/** Strip comment markers: `//`, `#`, `/*`, `*`, `*\/`, `/**`. */
export function cleanComment(raw: string): string {
  return raw
    .replace(/^\/\*+|\*+\/$/g, "")
    .split("\n")
    .map((l) => l.replace(/^\s*(\/\/+|#+|\*+(?!\/))\s?/, "").trimEnd())
    .join("\n")
    .trim();
}

/** Rationale comments in a parsed file; adjacent line comments are read as one. */
export function whyComments(root: Node): RawWhy[] {
  const comments = root.descendantsOfType("comment").filter((c): c is Node => !!c);
  const groups: { start: Node; end: Node; parts: string[] }[] = [];
  let prevNoise = false;
  for (const c of comments) {
    // Licence lines and tool directives end a run of line comments and are not rationale.
    const noise = NOISE.test(c.text);
    if (noise) {
      prevNoise = true;
      continue;
    }
    const last = groups.at(-1);
    const isLine = /^(\/\/|#)/.test(c.text);
    const follows = !prevNoise;
    prevNoise = false;
    if (
      last &&
      follows &&
      isLine &&
      /^(\/\/|#)/.test(last.end.text) &&
      c.startPosition.row === last.end.endPosition.row + 1 &&
      c.startPosition.column === last.end.startPosition.column
    ) {
      last.end = c;
      last.parts.push(c.text);
    } else groups.push({ start: c, end: c, parts: [c.text] });
  }
  const out: RawWhy[] = [];
  for (const g of groups) {
    const text = cleanComment(g.parts.join("\n")).replace(/\s+/g, " ");
    if (text.length < 20 || NOISE.test(text) || !WHY_PATTERN.test(text)) continue;
    out.push({
      line: g.start.startPosition.row + 1,
      endLine: g.end.endPosition.row + 1,
      text: text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text,
    });
    if (out.length >= MAX_PER_FILE) break;
  }
  return out;
}
