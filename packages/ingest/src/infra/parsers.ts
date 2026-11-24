import {
  LineCounter,
  isMap,
  isScalar,
  isSeq,
  parseAllDocuments,
  type Node as YamlNode,
  type YAMLMap,
} from "yaml";
import type { Evidence } from "@buildrax/ir";
import { ENV_HINTS, imageRepo, serviceForImage, TF_COMPUTE, TF_RESOURCES } from "./catalog.js";
import { parseCpu, parseMemoryMb, type InfraCollector } from "./collector.js";

const cfg = (file: string, line: number, detail: string): Evidence => ({
  kind: "config",
  file,
  startLine: line,
  detail,
});

/** Parse every YAML document in a file; returns [] for templated or invalid YAML. */
function yamlDocs(text: string): {
  docs: unknown[];
  lineOf(node: YamlNode | null | undefined): number;
} {
  const lc = new LineCounter();
  try {
    const parsed = parseAllDocuments(text, { lineCounter: lc, uniqueKeys: false });
    const list = Array.isArray(parsed) ? parsed : [parsed];
    if (list.some((d) => d.errors.length)) return { docs: [], lineOf: () => 1 };
    return {
      docs: list.map((d) => d.contents),
      lineOf: (node) => (node?.range ? lc.linePos(node.range[0]).line : 1),
    };
  } catch {
    return { docs: [], lineOf: () => 1 };
  }
}

const getIn = (map: unknown, key: string): YamlNode | undefined =>
  isMap(map) ? ((map as YAMLMap).get(key, true) as YamlNode | undefined) : undefined;
const scalar = (n: unknown): string | number | boolean | undefined =>
  isScalar(n) ? (n.value as string | number | boolean) : undefined;

// ---------------------------------------------------------------- docker compose

/**
 * Compose services: infrastructure images (postgres, redis, ...) become infra nodes; services
 * built from the repo become compute nodes. `depends_on` becomes `uses` links.
 */
export function parseCompose(
  file: string,
  text: string,
  c: InfraCollector,
  dockerfileDirs: Map<string, string>,
): void {
  const { docs, lineOf } = yamlDocs(text);
  const root = docs[0];
  const services = getIn(root, "services");
  if (!isMap(services)) return;
  const idOf = new Map<string, string>();
  for (const pair of (services as YAMLMap).items) {
    const name = String(scalar(pair.key) ?? "");
    const svc = pair.value;
    if (!name || !isMap(svc)) continue;
    const line = lineOf(pair.key as YamlNode);
    const image = scalar(getIn(svc, "image"));
    const deploy = getIn(svc, "deploy");
    const limits =
      getIn(getIn(getIn(deploy, "resources"), "limits"), "cpus") !== undefined
        ? getIn(getIn(deploy, "resources"), "limits")
        : getIn(getIn(deploy, "resources"), "reservations");
    const facts = {
      replicas: Number(scalar(getIn(deploy, "replicas"))) || undefined,
      cpu: parseCpu(scalar(getIn(limits, "cpus"))),
      memoryMb: parseMemoryMb(scalar(getIn(limits, "memory"))),
    };
    const infra = typeof image === "string" ? serviceForImage(image) : undefined;
    if (infra) {
      const tag = imageRepo(String(image)).tag;
      idOf.set(
        name,
        c.add(infra, "compose", cfg(file, line, `compose service "${name}" (${image})`), {
          ...facts,
          version: tag?.match(/^\d+(\.\d+)?/)?.[0],
        }),
      );
      continue;
    }
    // An application service (built from the repo, or an unknown image).
    const build = getIn(svc, "build");
    const context =
      typeof scalar(build) === "string"
        ? String(scalar(build))
        : String(scalar(getIn(build, "context")) ?? "");
    const runtime = context ? dockerfileDirs.get(normDir(file, context)) : undefined;
    idOf.set(
      name,
      c.add(
        { kind: "compute", key: `svc-${name}`, label: name },
        "compose",
        cfg(file, line, `compose service "${name}"`),
        {
          ...facts,
          image: typeof image === "string" ? image : undefined,
          runtime,
        },
      ),
    );
  }
  for (const pair of (services as YAMLMap).items) {
    const name = String(scalar(pair.key) ?? "");
    const from = idOf.get(name);
    const deps = getIn(pair.value, "depends_on");
    if (!from || !deps) continue;
    const names = isSeq(deps)
      ? deps.items.map((i) => String(scalar(i)))
      : isMap(deps)
        ? (deps as YAMLMap).items.map((i) => String(scalar(i.key)))
        : [];
    for (const dep of names) {
      const to = idOf.get(dep);
      if (to) c.link(from, to, "uses", cfg(file, lineOf(deps), `"${name}" depends on "${dep}"`));
    }
  }
}

/** Resolve a compose build context against the compose file's directory (POSIX, repo-relative). */
function normDir(composeFile: string, context: string): string {
  const base = composeFile.includes("/") ? composeFile.slice(0, composeFile.lastIndexOf("/")) : "";
  const parts = [...(base ? base.split("/") : []), ...context.split("/")].filter(
    (p) => p && p !== ".",
  );
  const out: string[] = [];
  for (const p of parts) {
    if (p === "..") out.pop();
    else out.push(p);
  }
  return out.join("/");
}

// ---------------------------------------------------------------- Dockerfile

/** Runtime image of the final stage, e.g. `node:20-alpine`. */
export function dockerfileRuntime(text: string): { image: string; line: number } | undefined {
  let last: { image: string; line: number } | undefined;
  text.split("\n").forEach((l, i) => {
    const m = /^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)/i.exec(l);
    if (m && !/^\$/.test(m[1]!)) last = { image: m[1]!, line: i + 1 };
  });
  return last;
}

// ---------------------------------------------------------------- Terraform

interface TfBlock {
  type: string;
  name: string;
  line: number;
  attrs: Map<string, string>;
}

/**
 * Minimal, static Terraform scanner: `resource "type" "name" { key = value }` blocks with their
 * top-level string/number/bool attributes. Expressions (var.x, locals) are kept as raw text and
 * are not treated as sizes.
 */
export function scanTerraform(text: string): TfBlock[] {
  const blocks: TfBlock[] = [];
  const re = /resource\s+"([\w-]+)"\s+"([\w-]+)"\s*\{/g;
  for (const m of text.matchAll(re)) {
    const start = (m.index ?? 0) + m[0].length;
    let depth = 1;
    let i = start;
    let inStr = false;
    for (; i < text.length && depth > 0; i++) {
      const ch = text[i];
      if (ch === '"' && text[i - 1] !== "\\") inStr = !inStr;
      else if (!inStr && ch === "{") depth++;
      else if (!inStr && ch === "}") depth--;
    }
    const body = text.slice(start, i - 1);
    const attrs = new Map<string, string>();
    let d = 0;
    for (const raw of body.split("\n")) {
      const line = raw.replace(/#.*$|\/\/.*$/, "");
      if (d === 0) {
        const a = /^\s*([A-Za-z_][\w-]*)\s*=\s*(.+?)\s*$/.exec(line);
        if (a) attrs.set(a[1]!, a[2]!.replace(/^"(.*)"$/, "$1"));
      }
      for (const ch of line) {
        if (ch === "{" || ch === "[") d++;
        else if (ch === "}" || ch === "]") d--;
      }
    }
    blocks.push({
      type: m[1]!,
      name: m[2]!,
      line: text.slice(0, m.index).split("\n").length,
      attrs,
    });
  }
  return blocks;
}

/** A constant value, or undefined when it is an expression (var.x, local.y, "${...}", f(), [..]). */
const literal = (v: string | undefined): string | undefined =>
  v && !/\b(var|local|module|data)\.|\$\{|\(|\[/.test(v) ? v : undefined;

export function parseTerraform(file: string, text: string, c: InfraCollector): void {
  for (const b of scanTerraform(text)) {
    const ev = cfg(file, b.line, `resource "${b.type}" "${b.name}"`);
    const a = (k: string): string | undefined => literal(b.attrs.get(k));
    const def = TF_RESOURCES[b.type];
    if (def) {
      const engine =
        a("engine")?.replace(/^aurora-/, "") ??
        a("database_version")
          ?.toLowerCase()
          .replace(/_\d.*$/, "");
      const key =
        def.kind === "database" && engine
          ? engine.startsWith("postgres")
            ? "postgres"
            : engine.startsWith("mysql") || engine.startsWith("mariadb")
              ? "mysql"
              : def.key
          : def.kind === "cache" && engine
            ? engine
            : def.key;
      c.add({ ...def, key }, "terraform", ev, {
        engine: engine ?? def.engine,
        version: a("engine_version"),
        instanceType: a("instance_class") ?? a("node_type") ?? a("tier") ?? a("sku_name"),
        replicas: Number(a("num_cache_nodes") ?? a("num_cache_clusters")) || undefined,
        storageGb: Number(a("allocated_storage")) || undefined,
        multiAz: a("multi_az") === "true" ? true : a("multi_az") === "false" ? false : undefined,
      });
      continue;
    }
    const comp = TF_COMPUTE[b.type];
    if (comp) {
      c.add(
        {
          kind: "compute",
          key: `tf-${b.name}`,
          label: `${comp.label} ${b.name}`,
          provider: comp.provider,
          engine: comp.engine,
        },
        "terraform",
        ev,
        {
          replicas: Number(a("desired_count")) || undefined,
          instanceType: a("instance_type"),
          memoryMb: Number(a("memory_size")) || undefined,
          runtime: a("runtime"),
        },
      );
    }
    if (b.type === "aws_ecs_task_definition") {
      // Fargate task size: cpu in CPU units (1024 = 1 vCPU), memory in MiB.
      const cpuUnits = Number(a("cpu"));
      c.add(
        {
          kind: "compute",
          key: `tf-${b.name}`,
          label: `ECS task ${b.name}`,
          provider: "aws",
          engine: "ecs",
        },
        "terraform",
        ev,
        {
          cpu: cpuUnits ? cpuUnits / 1024 : undefined,
          memoryMb: Number(a("memory")) || undefined,
        },
      );
    }
  }
}

// ---------------------------------------------------------------- Kubernetes

export function parseKubernetes(file: string, text: string, c: InfraCollector): void {
  const { docs, lineOf } = yamlDocs(text);
  for (const doc of docs) {
    const kind = scalar(getIn(doc, "kind"));
    if (!["Deployment", "StatefulSet", "DaemonSet"].includes(String(kind))) continue;
    const meta = getIn(doc, "metadata");
    const name = String(scalar(getIn(meta, "name")) ?? "app");
    const spec = getIn(doc, "spec");
    const containers = getIn(getIn(getIn(spec, "template"), "spec"), "containers");
    const first = isSeq(containers) ? containers.items[0] : undefined;
    const image = scalar(getIn(first, "image"));
    const requests = getIn(getIn(first, "resources"), "requests");
    const facts = {
      replicas: Number(scalar(getIn(spec, "replicas"))) || (kind === "DaemonSet" ? undefined : 1),
      cpu: parseCpu(scalar(getIn(requests, "cpu"))),
      memoryMb: parseMemoryMb(scalar(getIn(requests, "memory"))),
      image: typeof image === "string" ? image : undefined,
    };
    const ev = cfg(file, lineOf(meta ?? null), `${kind} "${name}"`);
    const infra = typeof image === "string" ? serviceForImage(image) : undefined;
    if (infra) c.add(infra, "kubernetes", ev, facts);
    else
      c.add(
        {
          kind: "compute",
          key: `k8s-${name}`,
          label: name,
          provider: "kubernetes",
          engine: "kubernetes",
        },
        "kubernetes",
        ev,
        facts,
      );
  }
}

// ---------------------------------------------------------------- deploy platforms

export function parsePlatform(file: string, text: string, c: InfraCollector): void {
  const base = file.slice(file.lastIndexOf("/") + 1);
  const ev = (line = 1, detail = base): Evidence => cfg(file, line, detail);
  if (base === "vercel.json")
    c.add(
      { kind: "hosting", key: "vercel", label: "Vercel", provider: "vercel" },
      "platform",
      ev(),
    );
  else if (base === "netlify.toml")
    c.add(
      { kind: "hosting", key: "netlify", label: "Netlify", provider: "netlify" },
      "platform",
      ev(),
    );
  else if (base === "fly.toml") {
    const mem = /^\s*memory(?:_mb)?\s*=\s*"?([\w.]+)"?/m.exec(text);
    const cpus = /^\s*cpus\s*=\s*(\d+)/m.exec(text);
    c.add({ kind: "hosting", key: "fly", label: "Fly.io", provider: "fly" }, "platform", ev(), {
      memoryMb: mem ? parseMemoryMb(/^\d+$/.test(mem[1]!) ? Number(mem[1]) : mem[1]) : undefined,
      cpu: cpus ? Number(cpus[1]) : undefined,
    });
  } else if (base === "render.yaml") {
    const { docs, lineOf } = yamlDocs(text);
    const services = getIn(docs[0], "services");
    if (!isSeq(services)) return;
    for (const s of services.items) {
      const name = String(scalar(getIn(s, "name")) ?? "service");
      c.add(
        {
          kind: "compute",
          key: `render-${name}`,
          label: `${name} (Render)`,
          provider: "render",
          engine: String(scalar(getIn(s, "type")) ?? "web"),
        },
        "platform",
        ev(lineOf(s as YamlNode), `render service "${name}"`),
        {
          plan: scalar(getIn(s, "plan")) as string | undefined,
          replicas: Number(scalar(getIn(s, "numInstances"))) || undefined,
        },
      );
    }
  } else if (base === "Procfile") {
    text.split("\n").forEach((l, i) => {
      const m = /^([\w-]+):\s*(.+)$/.exec(l.trim());
      if (m)
        c.add(
          { kind: "compute", key: `proc-${m[1]}`, label: `${m[1]} process`, engine: "procfile" },
          "platform",
          ev(i + 1, `Procfile "${m[1]}"`),
        );
    });
  } else if (base === "serverless.yml" || base === "serverless.yaml") {
    const { docs, lineOf } = yamlDocs(text);
    const provider = getIn(docs[0], "provider");
    const fns = getIn(docs[0], "functions");
    const count = isMap(fns) ? (fns as YAMLMap).items.length : 0;
    c.add(
      {
        kind: "compute",
        key: "serverless",
        label: `Serverless functions (${count})`,
        provider: String(scalar(getIn(provider, "name")) ?? "aws"),
        engine: "lambda",
      },
      "platform",
      ev(lineOf(provider ?? null), "serverless.yml"),
      {
        runtime: scalar(getIn(provider, "runtime")) as string | undefined,
        memoryMb: Number(scalar(getIn(provider, "memorySize"))) || undefined,
        replicas: count || undefined,
      },
    );
  }
}

// ---------------------------------------------------------------- Prisma, env names

/** `datasource db { provider = "postgresql" }` → engine. */
export function prismaProvider(text: string): { engine: string; line: number } | undefined {
  const block = /datasource\s+\w+\s*\{[^}]*\}/m.exec(text);
  if (!block) return undefined;
  const p = /provider\s*=\s*"(\w+)"/.exec(block[0]);
  if (!p) return undefined;
  const engine =
    p[1] === "postgresql"
      ? "postgres"
      : p[1] === "mysql"
        ? "mysql"
        : p[1] === "mongodb"
          ? "mongodb"
          : p[1]!;
  return {
    engine,
    line: text.slice(0, (block.index ?? 0) + block[0].indexOf(p[0])).split("\n").length,
  };
}

/**
 * `.env.example`-style files: only variable NAMES are read; values are never looked at. These are
 * weak hints and only mark a service as "inferred".
 */
export function parseEnvNames(file: string, text: string, c: InfraCollector): void {
  text.split("\n").forEach((l, i) => {
    const m = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/.exec(l);
    if (!m) return;
    const hint = ENV_HINTS.find((h) => h.match.test(m[1]!));
    if (hint)
      c.add(hint.def, "env", {
        kind: "inferred",
        file,
        startLine: i + 1,
        detail: `environment variable name ${m[1]}`,
      });
  });
}
