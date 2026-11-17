import type { GraphIndex } from "@buildrax/graph";
import { validateResearch, type Finding, type ResearchFile } from "@buildrax/ir";
import { h } from "./dom.js";

/** Only http(s) URLs are ever turned into links. */
export function safeHref(url: string): string | undefined {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** Findings for a node: its own, plus those of external dependencies used inside it. */
export function findingsFor(
  file: ResearchFile | undefined,
  index: GraphIndex,
  nodeId: string,
): Finding[] {
  if (!file) return [];
  const scope = new Set([nodeId, ...index.descendants(nodeId)]);
  const externals = new Set<string>();
  for (const id of scope)
    for (const e of index.out(id)) if (index.node(e.to)?.kind === "external") externals.add(e.to);
  const wanted = new Set([nodeId, ...externals]);
  return file.findings.filter((f) => wanted.has(f.nodeId));
}

export function parseResearch(raw: unknown): ResearchFile | undefined {
  if (raw === undefined) return undefined;
  const checked = validateResearch(raw);
  return checked.ok ? checked.file : undefined;
}

function findingView(f: Finding): HTMLElement {
  const href = safeHref(f.sourceUrl);
  return h(
    "li",
    { class: "finding" },
    h(
      "div",
      null,
      h("strong", null, f.subject),
      " ",
      h("span", { class: `badge rel-${f.reliability}` }, `${f.reliability} reliability`),
    ),
    h("div", null, f.finding),
    f.recommendedAction ? h("div", { class: "warn" }, `Suggested: ${f.recommendedAction}`) : null,
    h(
      "div",
      { class: "muted" },
      `${f.evidenceType} · ${f.publisher} · retrieved ${f.retrievedAt.slice(0, 10)}`,
      f.applicableVersion ? ` · applies to ${f.applicableVersion}` : "",
    ),
    f.reliabilityNote ? h("div", { class: "muted" }, f.reliabilityNote) : null,
    href
      ? h("a", { href, target: "_blank", rel: "noopener noreferrer" }, "source")
      : h("span", { class: "muted" }, f.sourceUrl),
  );
}

/** Inspector section: dated, source-linked external research. Facts only, never auto-applied. */
export function renderResearchSection(
  file: ResearchFile | undefined,
  index: GraphIndex,
  nodeId: string,
): HTMLElement | null {
  const items = findingsFor(file, index, nodeId);
  if (!file) return null;
  return h(
    "section",
    { class: "research-section" },
    h("h3", null, `External research (${items.length})`),
    items.length
      ? h("ul", { class: "findings" }, ...items.map(findingView))
      : h("p", { class: "muted" }, "No findings for this node."),
    h(
      "p",
      { class: "muted" },
      `Fetched ${file.generatedAt.slice(0, 10)}. Registry data describes the latest release, not necessarily the version you run.`,
    ),
  );
}
