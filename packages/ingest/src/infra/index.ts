import { promises as fs } from "node:fs";
import path from "node:path";
import type { IREdge, IRNode, Model } from "@buildrax/ir";
import { SDK_SERVICES } from "./catalog.js";
import { InfraCollector } from "./collector.js";
import {
  dockerfileRuntime,
  parseCompose,
  parseEnvNames,
  parseKubernetes,
  parsePlatform,
  parseTerraform,
  prismaProvider,
} from "./parsers.js";

export { SDK_SERVICES, serviceForImage, imageRepo } from "./catalog.js";
export type { InfraKind, ServiceDef } from "./catalog.js";
export { parseCpu, parseMemoryMb } from "./collector.js";
export type { InfraFacts } from "./collector.js";
export { scanTerraform, dockerfileRuntime, prismaProvider } from "./parsers.js";

const MAX_BYTES = 512_000;
const PLATFORM_FILES = new Set([
  "vercel.json",
  "netlify.toml",
  "fly.toml",
  "render.yaml",
  "Procfile",
  "serverless.yml",
  "serverless.yaml",
]);
const isCompose = (f: string): boolean => /(^|\/)(docker-)?compose(\.[\w-]+)?\.ya?ml$/.test(f);
const isDockerfile = (f: string): boolean => /(^|\/)Dockerfile(\.[\w-]+)?$/.test(f);
const isEnvExample = (f: string): boolean => /(^|\/)\.env\.(example|sample|template|dist)$/.test(f);
const isK8s = (f: string): boolean =>
  /(^|\/)(k8s|kubernetes|kube|deploy|deployment|manifests|helm)\//.test(f) && /\.ya?ml$/.test(f);

/**
 * Static infrastructure detection: what the project runs on and pays for, from deploy and config
 * files plus SDK usage already in the model. Nothing is executed and no secret values are read
 * (only `.env.example`-style variable names; a real `.env` is never opened).
 */
export async function detectInfra(
  root: string,
  files: readonly string[],
  model: Model,
): Promise<{ nodes: IRNode[]; edges: IREdge[] }> {
  const project = model.nodes.find((n) => n.kind === "project")?.id ?? "project:repo";
  const c = new InfraCollector(project);
  const read = async (rel: string): Promise<string | undefined> => {
    try {
      const abs = path.join(root, rel);
      if ((await fs.stat(abs)).size > MAX_BYTES) return undefined;
      return await fs.readFile(abs, "utf8");
    } catch {
      return undefined;
    }
  };

  // Dockerfile runtimes, by directory (used to describe compose services built from them).
  const runtimes = new Map<string, string>();
  for (const f of files.filter(isDockerfile)) {
    const rt = dockerfileRuntime((await read(f)) ?? "");
    if (rt) runtimes.set(f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : "", rt.image);
  }
  const composeFiles = files.filter(isCompose);
  for (const f of composeFiles) parseCompose(f, (await read(f)) ?? "", c, runtimes);
  // Dockerfiles not used by any compose service still describe a deployable container.
  for (const f of files.filter(isDockerfile)) {
    const dir = f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : "";
    const text = (await read(f)) ?? "";
    const rt = dockerfileRuntime(text);
    if (!rt || composeFiles.length) continue;
    const name = dir ? dir.slice(dir.lastIndexOf("/") + 1) : path.basename(root);
    c.add(
      { kind: "compute", key: `svc-${name}`, label: name },
      "dockerfile",
      { kind: "config", file: f, startLine: rt.line, detail: `FROM ${rt.image}` },
      { runtime: rt.image },
    );
  }
  for (const f of files.filter((x) => x.endsWith(".tf")))
    parseTerraform(f, (await read(f)) ?? "", c);
  for (const f of files.filter(isK8s)) parseKubernetes(f, (await read(f)) ?? "", c);
  for (const f of files.filter((x) => PLATFORM_FILES.has(x.slice(x.lastIndexOf("/") + 1))))
    parsePlatform(f, (await read(f)) ?? "", c);
  for (const f of files.filter(isEnvExample)) parseEnvNames(f, (await read(f)) ?? "", c);

  // Prisma: the datasource provider tells which database the ORM talks to.
  let prismaDb: string | undefined;
  for (const f of files.filter((x) => x.endsWith("schema.prisma"))) {
    const p = prismaProvider((await read(f)) ?? "");
    if (!p) continue;
    const def =
      p.engine === "postgres"
        ? { kind: "database" as const, key: "postgres", label: "PostgreSQL" }
        : { kind: "database" as const, key: p.engine, label: p.engine };
    prismaDb = c.add(
      def,
      "prisma",
      { kind: "config", file: f, startLine: p.line, detail: "Prisma datasource" },
      { engine: p.engine },
    );
  }

  // SDK usage: code that imports a client library uses that service (verified, with file:line).
  for (const e of model.edges) {
    if (!e.to.startsWith("external:")) continue;
    const pkg = e.to.slice("external:".length).toLowerCase();
    const ev = e.evidence[0];
    if (!ev) continue;
    const def = SDK_SERVICES[pkg];
    const target = def
      ? c.add(def, "sdk", { ...ev, kind: "verified", detail: `imports ${pkg}` })
      : (pkg === "@prisma/client" || pkg === "prisma") && prismaDb
        ? prismaDb
        : undefined;
    if (target)
      c.link(e.from, target, "uses", { ...ev, kind: "verified", detail: `imports ${pkg}` });
  }
  return c.result();
}

/** Add detected infrastructure to a model (deterministic order, updated stats). */
export function withInfra(model: Model, infra: { nodes: IRNode[]; edges: IREdge[] }): Model {
  const byId = <T extends { id: string }>(a: T, b: T): number =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  const existing = new Set(model.nodes.map((n) => n.id));
  const nodes = [...model.nodes, ...infra.nodes.filter((n) => !existing.has(n.id))].sort(byId);
  const ids = new Set(nodes.map((n) => n.id));
  const edges = [
    ...model.edges,
    ...infra.edges.filter((e) => ids.has(e.from) && ids.has(e.to)),
  ].sort(byId);
  return {
    ...model,
    nodes,
    edges,
    meta: {
      ...model.meta,
      stats: {
        ...(model.meta.stats ?? {}),
        nodes: nodes.length,
        edges: edges.length,
        infra: infra.nodes.length,
      },
    },
  };
}
