import { ABSENT_NOTE, buildDesign, type DesignModel, type Provenance } from "@buildrax/design";
import type { ReviewFile } from "@buildrax/ir";
import { loadFunctions, loadModel, loadRationale, loadResearch } from "./data.js";

export const PROVENANCE_LABEL: Record<Provenance, string> = {
  code: "from code",
  config: "from config",
  documented: "documented",
  researched: "researched",
  inferred: "inferred",
  ai: "AI inference, unverified",
};

/** Build the design model from the scan's files (side files are optional; missing ones thin it). */
export async function designCommand(repo: string): Promise<DesignModel> {
  const model = await loadModel(repo);
  const [functions, rationale, research] = await Promise.all([
    loadFunctions(repo).catch(() => undefined),
    loadRationale(repo).catch(() => undefined),
    loadResearch(repo).catch(() => undefined),
  ]);
  return buildDesign({ model, functions, rationale, research });
}

const MARK = { present: "✓", absent: "·", risk: "!", unknown: "?" } as const;

export function formatDesign(
  d: DesignModel,
  opts: { level?: 1 | 2 | 3; review?: ReviewFile } = {},
): string {
  const level = opts.level ?? 2;
  const name = (id: string): string => d.c4.elements.find((e) => e.id === id)?.name ?? id;
  const out: string[] = [
    `DESIGN ${d.repo}  (deterministic: from code, config and docs; no AI)`,
    "",
    "SYSTEM CONTEXT (C1)",
  ];
  for (const e of d.c4.elements.filter((x) => x.level === 1))
    out.push(`  ${e.name} [${e.kind}] ${e.description}  (${PROVENANCE_LABEL[e.provenance]})`);
  for (const r of d.c4.relations.filter((x) => x.level === 1))
    out.push(`    ${name(r.from)} -> ${name(r.to)}: ${r.label}`);

  if (level >= 2) {
    out.push("", "CONTAINERS (C2)");
    for (const e of d.c4.elements.filter((x) => x.level === 2))
      out.push(
        `  ${e.name} [${e.kind}] ${e.description}${e.deployedAs?.length ? `  deployed as ${e.deployedAs.join(", ")}` : ""}`,
      );
    const rels = d.c4.relations.filter((x) => x.level === 2);
    if (rels.length) out.push("  Relationships");
    for (const r of rels)
      out.push(
        `    ${name(r.from)} -> ${name(r.to)}: ${r.label}  (${PROVENANCE_LABEL[r.provenance]})`,
      );
    if (d.c4.deployment.length)
      out.push(`  Deployment not tied to a folder: ${d.c4.deployment.join(", ")}`);
  }

  if (level >= 3) {
    out.push("", "COMPONENTS (C3)");
    for (const c of d.c4.elements.filter(
      (x) => x.level === 2 && x.id.startsWith("c4:container:"),
    )) {
      out.push(`  ${c.name}`);
      for (const e of d.c4.elements.filter((x) => x.level === 3 && x.parent === c.id)) {
        out.push(
          `    ${e.name}${e.tags.length ? ` [${e.tags.join(", ")}]` : ""}  ${e.files ?? 0} file(s)${e.functions !== undefined ? `, ${e.functions} function(s)` : ""}`,
        );
        for (const r of d.c4.relations.filter((x) => x.level === 3 && x.from === e.id))
          out.push(`      -> ${name(r.to)}: ${r.label}`);
      }
    }
  }

  out.push("", `CONCEPTS (${d.concepts.length})`);
  for (const c of d.concepts)
    out.push(
      `  ${c.category.padEnd(13)} ${c.name}: ${c.detail}  (${PROVENANCE_LABEL[c.provenance]}${c.documentedBy?.length ? `; documented in ${c.documentedBy.length} place(s)` : ""})`,
    );

  out.push("", "NFR SCORECARD  (✓ present · absent ! risk ? unknown; counts, not grades)");
  for (const s of d.scorecard.summary) {
    out.push(
      `  ${s.category.padEnd(15)} ${s.present} present, ${s.absent} absent, ${s.risk} risk${s.unknown ? `, ${s.unknown} unknown` : ""}`,
    );
    for (const c of d.scorecard.checks.filter((x) => x.category === s.category))
      out.push(`    ${MARK[c.status]} ${c.label}: ${c.detail}`);
  }
  if (opts.review) out.push(...formatReview(opts.review, d.scannedAt));
  out.push("", ABSENT_NOTE);
  if (!d.inputs.rationale || !d.inputs.functions)
    out.push("Run `buildrax scan` again to add the function and rationale indexes to this view.");
  if (level < 3) out.push("Use --level 3 for components inside each container.");
  return out.join("\n");
}

export function formatReview(r: ReviewFile, scannedAt: string): string[] {
  const out = [
    "",
    `REVIEW (${r.items.length}) by ${r.agent ?? "your agent"}, imported ${r.importedAt.slice(0, 10)}: AI inference, unverified unless cited`,
  ];
  if (r.modelScannedAt !== scannedAt)
    out.push("  (checked against an older scan; the code may have changed since)");
  for (const it of r.items)
    out.push(
      `  ${it.type.toUpperCase()}${it.severity ? ` [${it.severity}]` : ""} ${it.title}  (${it.cited ? "AI inference, cited" : "AI inference, unverified"})`,
      `    ${it.body}`,
      ...(it.evidence?.length
        ? [`    read: ${it.evidence.map((e) => `${e.file}:${e.line}`).join(", ")}`]
        : []),
      ...(it.sources?.length
        ? [`    sources: ${it.sources.map((s) => `${s.url} (${s.accessed})`).join(", ")}`]
        : []),
    );
  return out;
}
