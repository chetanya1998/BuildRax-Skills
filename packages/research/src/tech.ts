import type { Model } from "@buildrax/ir";
import type { Ecosystem, Technology } from "./types.js";

const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const PYPI_NAME = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;

/**
 * Only well-formed package names may ever leave the machine. This is the privacy gate: a name
 * that is not a plain registry identifier (for example one carrying code, paths or secrets) is
 * dropped, so queries cannot be used to smuggle repository content.
 */
export function isSafePackageName(name: string, ecosystem: Ecosystem): boolean {
  if (name.length === 0 || name.length > 214) return false;
  return (ecosystem === "npm" ? NPM_NAME : PYPI_NAME).test(name);
}

/** External dependencies in the IR, most-used first, restricted to safe registry names. */
export function extractTechnologies(model: Model): Technology[] {
  const used = new Map<string, number>();
  for (const e of model.edges) used.set(e.to, (used.get(e.to) ?? 0) + 1);
  const out: Technology[] = [];
  for (const n of model.nodes) {
    if (n.kind !== "external") continue;
    const ecosystem = n.meta?.ecosystem;
    if (ecosystem !== "npm" && ecosystem !== "pypi") continue;
    if (!isSafePackageName(n.name, ecosystem)) continue;
    out.push({ name: n.name, ecosystem, nodeId: n.id, usedBy: used.get(n.id) ?? 0 });
  }
  return out.sort((a, b) => b.usedBy - a.usedBy || (a.name < b.name ? -1 : 1));
}
