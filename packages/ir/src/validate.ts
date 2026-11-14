import { ModelSchema, type Model } from "./schema.js";

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  model?: Model;
}

/** Structural validation (zod) plus cross-reference checks. */
export function validateModel(input: unknown): ValidationResult {
  const parsed = ModelSchema.safeParse(input);
  if (!parsed.success) {
    const errors = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    return { ok: false, errors };
  }
  const model = parsed.data;
  const errors: string[] = [];

  const ids = new Set<string>();
  for (const n of model.nodes) {
    if (ids.has(n.id)) errors.push(`nodes: duplicate id "${n.id}"`);
    ids.add(n.id);
  }
  for (const n of model.nodes) {
    if (n.parent !== undefined && !ids.has(n.parent)) {
      errors.push(`node "${n.id}": parent "${n.parent}" does not exist`);
    }
  }
  const edgeIds = new Set<string>();
  for (const e of model.edges) {
    if (edgeIds.has(e.id)) errors.push(`edges: duplicate id "${e.id}"`);
    edgeIds.add(e.id);
    if (!ids.has(e.from)) errors.push(`edge "${e.id}": from "${e.from}" does not exist`);
    if (!ids.has(e.to)) errors.push(`edge "${e.id}": to "${e.to}" does not exist`);
  }
  errors.push(...parentCycleErrors(model));

  return errors.length ? { ok: false, errors } : { ok: true, errors: [], model };
}

function parentCycleErrors(model: Model): string[] {
  const parentOf = new Map(model.nodes.map((n) => [n.id, n.parent]));
  const errors: string[] = [];
  for (const n of model.nodes) {
    const seen = new Set<string>([n.id]);
    let cur = n.parent;
    while (cur !== undefined) {
      if (seen.has(cur)) {
        errors.push(`node "${n.id}": parent chain contains a cycle`);
        break;
      }
      seen.add(cur);
      cur = parentOf.get(cur);
    }
  }
  return errors;
}
