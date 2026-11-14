import type { EdgeKind, NodeKind } from "./schema.js";

/** Lowercase, replace runs of non-alphanumerics with "-", trim dashes. */
export function slug(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Deterministic node id: `<kind>:<key>`. For path-like kinds (file, module) the key is the
 * repo-relative POSIX path, unchanged, so ids stay unique and human readable.
 */
export function nodeId(kind: NodeKind, key: string): string {
  return `${kind}:${key}`;
}

export function edgeId(from: string, kind: EdgeKind, to: string): string {
  return `${from}->${kind}->${to}`;
}
