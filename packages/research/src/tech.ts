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

/** Versions that may be sent: plain release identifiers only (e.g. 4.21.2, 3.12, 1.0.0-rc.1). */
export const isSafeVersion = (v: string): boolean => /^[0-9][0-9A-Za-z.+-]{0,63}$/.test(v);

const versionsOf = (meta: Record<string, unknown> | undefined): string[] => {
  const one = meta?.["version"];
  const many = meta?.["versions"];
  const list = typeof one === "string" ? [one] : Array.isArray(many) ? many : [];
  return list.filter((v): v is string => typeof v === "string" && isSafeVersion(v));
};

/**
 * External dependencies in the IR, most-used first, restricted to safe registry names. A package
 * locked at several versions yields one entry per version (advisories differ); registry facts
 * are fetched once, for the `primary` entry.
 */
export function extractTechnologies(model: Model): Technology[] {
  const used = new Map<string, number>();
  for (const e of model.edges) used.set(e.to, (used.get(e.to) ?? 0) + 1);
  const out: Technology[] = [];
  for (const n of model.nodes) {
    if (n.kind !== "external") continue;
    const ecosystem = n.meta?.ecosystem;
    if (ecosystem !== "npm" && ecosystem !== "pypi") continue;
    if (!isSafePackageName(n.name, ecosystem)) continue;
    const t = { name: n.name, ecosystem, nodeId: n.id, usedBy: used.get(n.id) ?? 0 } as const;
    const versions = versionsOf(n.meta);
    if (!versions.length) out.push({ ...t, primary: true });
    versions.forEach((version, i) => out.push({ ...t, version, primary: i === 0 }));
  }
  return out.sort(
    (a, b) =>
      b.usedBy - a.usedBy ||
      (a.name < b.name ? -1 : a.name > b.name ? 1 : (a.version ?? "") < (b.version ?? "") ? -1 : 1),
  );
}

/** endoflife.date product ids for packages, databases and runtime images BuildRAX recognises. */
const PACKAGE_PRODUCTS: Record<string, [string, string]> = {
  "npm:next": ["nextjs", "Next.js"],
  "npm:react": ["react", "React"],
  "npm:express": ["express", "Express"],
  "npm:vue": ["vue", "Vue"],
  "npm:@angular/core": ["angular", "Angular"],
  "npm:@nestjs/core": ["nestjs", "NestJS"],
  "npm:nuxt": ["nuxt", "Nuxt"],
  "pypi:django": ["django", "Django"],
};
const ENGINE_PRODUCTS: Record<string, [string, string]> = {
  postgres: ["postgresql", "PostgreSQL"],
  redis: ["redis", "Redis"],
  valkey: ["valkey", "Valkey"],
  mysql: ["mysql", "MySQL"],
  mongodb: ["mongodb", "MongoDB"],
};
const RUNTIMES: Record<string, [string, string]> = {
  nodejs: ["nodejs", "Node.js"],
  node: ["nodejs", "Node.js"],
  python: ["python", "Python"],
};

/**
 * Products with a known version, for lifecycle (end-of-life) checks: framework packages with a
 * pinned version, databases and caches with a declared version, container runtime images
 * (`node:20-alpine`) and declared runtimes (`engines.node`, `.nvmrc`, `requires-python`).
 * Product names come from the fixed tables above, never from repository text.
 */
export function extractProducts(model: Model): Technology[] {
  const out = new Map<string, Technology>();
  const add = (
    p: [string, string] | undefined,
    version: string | undefined,
    nodeId: string,
  ): void => {
    if (!p || !version) return;
    const v = /^v?(\d+(?:\.\d+){0,2})/.exec(version)?.[1];
    if (!v) return;
    const key = `${p[0]}@${v}`;
    if (!out.has(key))
      out.set(key, {
        name: p[0],
        ecosystem: "product",
        version: v,
        label: p[1],
        nodeId,
        usedBy: 0,
        primary: true,
      });
  };
  for (const n of model.nodes) {
    const meta = n.meta as Record<string, unknown> | undefined;
    if (n.kind === "external") {
      const eco = meta?.["ecosystem"];
      for (const v of versionsOf(meta)) add(PACKAGE_PRODUCTS[`${eco}:${n.name}`], v, n.id);
    } else if (n.kind === "database" || n.kind === "cache") {
      const engine = typeof meta?.["engine"] === "string" ? (meta["engine"] as string) : undefined;
      const version =
        typeof meta?.["version"] === "string" ? (meta["version"] as string) : undefined;
      add(engine ? ENGINE_PRODUCTS[engine] : undefined, version, n.id);
    } else if (n.kind === "compute") {
      for (const key of ["runtime", "image"]) {
        const img = meta?.[key];
        if (typeof img !== "string") continue;
        const m = /^(?:[\w.-]+\/)*(node|python):v?(\d+(?:\.\d+){0,2})/.exec(img);
        if (m) add(RUNTIMES[m[1]!], m[2], n.id);
      }
    } else if (n.kind === "project" && Array.isArray(meta?.["runtimes"])) {
      for (const r of meta["runtimes"] as { product?: string; version?: string }[])
        add(r.product ? RUNTIMES[r.product] : undefined, r.version, n.id);
    }
  }
  return [...out.values()].sort((a, b) =>
    `${a.name}@${a.version}` < `${b.name}@${b.version}` ? -1 : 1,
  );
}
