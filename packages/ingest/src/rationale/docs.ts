/** Markdown read for rationale: ADRs as whole decisions, other docs split by heading. */

export interface RawDocSection {
  title: string;
  line: number;
  endLine: number;
  text: string;
}

export interface RawAdr {
  title: string;
  status?: string;
  date?: string;
  /** The Decision section when there is one, else the first paragraph. */
  summary: string;
  text: string;
}

const ADR_DIRS = new Set([
  "adr",
  "adrs",
  "decisions",
  "decision-records",
  "architecture-decisions",
  "architecture-decision-records",
]);
const SKIP = /^(changelog|history|license|licence|code_of_conduct|security|notice)\b/i;

export function isAdrPath(p: string): boolean {
  const parts = p.toLowerCase().split("/");
  const base = parts.at(-1)!;
  if (!/\.mdx?$/.test(base) || /^(readme|index|template)\b/.test(base)) return false;
  return parts.slice(0, -1).some((d) => ADR_DIRS.has(d)) || /^adr[-_ ]?\d+/.test(base);
}

/** Docs worth reading for rationale: ADRs, READMEs, ARCHITECTURE/DESIGN, and docs/ folders. */
export function isDocPath(p: string): boolean {
  const parts = p.split("/");
  const base = parts.at(-1)!;
  if (!/\.mdx?$/i.test(base) || SKIP.test(base)) return false;
  if (isAdrPath(p)) return true;
  if (/^(readme|architecture|design|overview|decisions?)\.mdx?$/i.test(base)) return true;
  return parts.slice(0, -1).some((d) => /^docs?$/i.test(d));
}

/** Markdown to short plain text: no fences, links as their text, single spaces. */
export function plainExcerpt(md: string, max = 300): string {
  const t = md
    .replace(/^(```|~~~)[\s\S]*?^\1.*$/gm, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, "")
    .replace(/[*_]{1,3}([^*_\n]+)[*_]{1,3}/g, "$1")
    .replace(/\|/g, " ")
    .replace(/(^|\s):?-{3,}:?(?=\s|$)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Heading text without markup (keeps numbering like "4. Use Kafka"). */
const headingText = (h: string): string =>
  h
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`]/g, "")
    .trim()
    .slice(0, 120);

/** Split by ATX headings (outside code fences). Text before the first heading is its own section. */
export function markdownSections(text: string): RawDocSection[] {
  const lines = text.split("\n");
  const out: RawDocSection[] = [];
  let fence: string | undefined;
  let cur: RawDocSection | undefined;
  const close = (end: number): void => {
    if (cur && cur.text.trim()) out.push({ ...cur, endLine: end, text: cur.text.trimEnd() });
  };
  lines.forEach((l, i) => {
    const f = /^\s{0,3}(```|~~~)/.exec(l)?.[1];
    if (f) fence = fence === f ? undefined : (fence ?? f);
    const h = !fence && !f ? /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(l) : null;
    if (h) {
      close(i);
      cur = { title: headingText(h[1]!), line: i + 1, endLine: i + 1, text: "" };
      return;
    }
    cur ??= { title: "", line: i + 1, endLine: i + 1, text: "" };
    cur.text += `${l}\n`;
  });
  close(lines.length);
  return out;
}

export function readAdr(text: string): RawAdr {
  const sections = markdownSections(text);
  const h1 = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/m.exec(text)?.[1];
  const title = h1 ? headingText(h1) : "Untitled decision";
  const head = text.split("\n").slice(0, 25).join("\n");
  const statusSection = sections.find((s) => /^status$/i.test(s.title));
  const status =
    /^\s*(?:[-*]\s*)?\**status\**\s*[:-]\s*\**\s*([A-Za-z][\w -]{1,30}?)\**\s*$/im.exec(
      head,
    )?.[1] ?? /^\s*([A-Za-z][\w-]{1,30})/.exec(statusSection?.text.trim() ?? "")?.[1];
  const date =
    /^\s*(?:[-*]\s*)?\**date\**\s*[:-]\s*\**\s*(\d{4}-\d{2}-\d{2})/im.exec(head)?.[1] ??
    /\b(\d{4}-\d{2}-\d{2})\b/.exec(head)?.[1];
  const decision = sections.find((s) =>
    /^(decision|decision outcome|the decision)$/i.test(s.title),
  );
  const firstBody = sections.find(
    (s) => s.text.trim() && !/^(status|date|context and problem statement)$/i.test(s.title),
  );
  return {
    title,
    ...(status ? { status: status.toLowerCase().trim() } : {}),
    ...(date ? { date } : {}),
    summary: plainExcerpt((decision ?? firstBody)?.text ?? "", 400),
    text,
  };
}
