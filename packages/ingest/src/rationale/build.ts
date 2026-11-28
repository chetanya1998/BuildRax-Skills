import {
  RATIONALE_SCHEMA_VERSION,
  type FunctionsFile,
  type Model,
  type RationaleFile,
  type RationaleLink,
  type RationaleSource,
} from "@buildrax/ir";
import type { RawWhy } from "./comments.js";
import { WHY_PATTERN } from "./comments.js";
import { plainExcerpt, isAdrPath, markdownSections, readAdr } from "./docs.js";
import type { RawCommit } from "./git.js";
import { buildMatcher } from "./match.js";

export interface RationaleInput {
  model: Model;
  /** Markdown files picked by `isDocPath`, with their text. */
  docs: { path: string; text: string }[];
  comments: { path: string; whys: RawWhy[] }[];
  functions?: FunctionsFile;
  /** undefined: git history was not read (not a repository, git missing, or turned off). */
  commits?: RawCommit[];
}

const MAX_COMMITS_PER_NODE = 8;
/** A commit touching more files than this is linked to the packages it touched instead. */
const WIDE_COMMIT = 15;
const ORDER: Record<RationaleSource["kind"], number> = { adr: 0, doc: 1, comment: 2, commit: 3 };

/** Rationale sources (ADRs, doc sections, "why" comments, commit messages) tied to model nodes. */
export function buildRationale(input: RationaleInput): RationaleFile {
  const { model } = input;
  const matcher = buildMatcher(model);
  const project = model.nodes.find((n) => n.kind === "project")?.id;
  const files = new Set(model.nodes.filter((n) => n.kind === "file").map((n) => n.id));
  const sources: RationaleSource[] = [];

  // ADRs: one source per decision, linked to what it names (or the project).
  for (const d of input.docs.filter((x) => isAdrPath(x.path))) {
    const adr = readAdr(d.text);
    let links = matcher.match(d.text);
    if (!links.length && project) links = [{ node: project, via: "project" }];
    sources.push({
      id: `adr:${d.path}`,
      kind: "adr",
      title: adr.title,
      file: d.path,
      line: 1,
      ...(adr.status ? { status: adr.status } : {}),
      ...(adr.date ? { date: adr.date } : {}),
      excerpt: adr.summary,
      links,
    });
  }

  // Other docs: only sections that clearly name something in the map.
  for (const d of input.docs.filter((x) => !isAdrPath(x.path))) {
    for (const s of markdownSections(d.text)) {
      const links = matcher.match(`${s.title}\n${s.text}`);
      if (!links.length) continue;
      sources.push({
        id: `doc:${d.path}#L${s.line}`,
        kind: "doc",
        title: s.title || d.path,
        file: d.path,
        line: s.line,
        endLine: s.endLine,
        excerpt: plainExcerpt(s.text),
        links,
      });
    }
  }

  // "Why" comments: in their file, and in (or just above) a function from the index.
  const fnsByFile = new Map(
    (input.functions?.files ?? []).map((f) => [f.path, f.functions] as const),
  );
  for (const c of input.comments) {
    const file = `file:${c.path}`;
    if (!files.has(file)) continue;
    const fns = fnsByFile.get(c.path) ?? [];
    for (const w of c.whys) {
      const above = fns.find((f) => f.line > w.endLine && f.line <= w.endLine + 2);
      const inside = fns
        .filter((f) => f.line <= w.line && w.endLine <= f.endLine)
        .sort((a, b) => a.endLine - a.line - (b.endLine - b.line))[0];
      const fn = above ?? inside;
      sources.push({
        id: `comment:${c.path}:${w.line}`,
        kind: "comment",
        title: fn ? fn.name : c.path,
        file: c.path,
        line: w.line,
        endLine: w.endLine,
        ...(fn ? { fn: fn.id } : {}),
        excerpt: w.text,
        links: [{ node: file, via: "location" }],
      });
    }
  }

  // Commit messages that explain something, tied to the files they changed.
  let explained = 0;
  if (input.commits) {
    const byId = new Map(model.nodes.map((n) => [n.id, n] as const));
    const topModule = (fileId: string): string | undefined => {
      let id: string | undefined = fileId;
      let last: string | undefined;
      while (id && byId.get(id)?.kind !== "project") {
        last = id;
        id = byId.get(id)?.parent;
      }
      return last && last !== fileId ? last : undefined;
    };
    for (const c of input.commits) {
      if (!(c.body.length >= 30 || WHY_PATTERN.test(c.subject))) continue;
      const touched = c.files.map((f) => `file:${f}`).filter((id) => files.has(id));
      let links: RationaleLink[] = touched.map((node) => ({ node, via: "changed" }));
      if (touched.length > WIDE_COMMIT)
        links = [...new Set(touched.map(topModule).filter((x): x is string => !!x))]
          .sort()
          .map((node) => ({ node, via: "changed" }));
      if (!links.length) continue;
      explained++;
      sources.push({
        id: `commit:${c.hash}`,
        kind: "commit",
        title: c.subject,
        date: c.date,
        hash: c.hash,
        excerpt: plainExcerpt(c.body || c.subject, 400),
        links: links.slice(0, 40),
      });
    }
  }

  // Index by node: decisions, docs, comments (by line), then the newest commits.
  const byNode: Record<string, string[]> = {};
  const commitsPer = new Map<string, number>();
  for (const s of sources)
    for (const l of s.links) {
      if (s.kind === "commit") {
        const n = commitsPer.get(l.node) ?? 0;
        if (n >= MAX_COMMITS_PER_NODE) continue;
        commitsPer.set(l.node, n + 1);
      }
      (byNode[l.node] ??= []).push(s.id);
    }
  const rank = new Map(sources.map((s, i) => [s.id, [ORDER[s.kind], i] as const]));
  for (const ids of Object.values(byNode))
    ids.sort((a, b) => rank.get(a)![0] - rank.get(b)![0] || rank.get(a)![1] - rank.get(b)![1]);

  const count = (k: RationaleSource["kind"]): number => sources.filter((s) => s.kind === k).length;
  return {
    schemaVersion: RATIONALE_SCHEMA_VERSION,
    repo: model.meta.repo,
    scannedAt: model.meta.scannedAt,
    stats: {
      adrs: count("adr"),
      docs: count("doc"),
      comments: count("comment"),
      commits: explained,
    },
    git: { read: !!input.commits, commits: input.commits?.length ?? 0 },
    sources,
    byNode: Object.fromEntries(Object.entries(byNode).sort(([a], [b]) => (a < b ? -1 : 1))),
  };
}
