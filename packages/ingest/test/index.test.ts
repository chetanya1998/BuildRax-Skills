import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateModel } from "@buildrax/ir";
import {
  extractImports,
  npmPackageName,
  resolvePython,
  resolveRelativeJs,
  scan,
} from "../src/index.js";

const FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../fixtures/sample-monorepo",
);
const NOW = "2026-01-01T00:00:00.000Z";

describe("extractImports", () => {
  it("finds static, re-export, dynamic and require imports in TS", async () => {
    const src = [
      'import a from "./a";',
      'export * from "./b";',
      'export { x } from "pkg";',
      'const c = require("c");',
      'const d = await import("./d");',
      "const e = 1;",
    ].join("\n");
    const specs = (await extractImports(src, "typescript")).map((i) => [i.specifier, i.line]);
    expect(specs).toEqual([
      ["./a", 1],
      ["./b", 2],
      ["pkg", 3],
      ["c", 4],
      ["./d", 5],
    ]);
  });

  it("finds Python imports, relative and absolute", async () => {
    const src = "import os, a.b as c\nfrom .x import y, z as w\nfrom .. import q\n";
    const out = await extractImports(src, "python");
    expect(out.map((i) => i.specifier)).toEqual(["a.b", "os", ".x", ".."]);
    expect(out[2]?.names).toEqual(["y", "z"]);
    expect(out[3]?.names).toEqual(["q"]);
  });
});

describe("resolution", () => {
  const files = new Set(["src/a.ts", "src/b/index.ts", "src/c.tsx"]);
  it("maps .js specifiers to TS sources and index files", () => {
    expect(resolveRelativeJs("src/m.ts", "./a.js", files)).toBe("src/a.ts");
    expect(resolveRelativeJs("src/m.ts", "./b", files)).toBe("src/b/index.ts");
    expect(resolveRelativeJs("src/m.ts", "./c", files)).toBe("src/c.tsx");
    expect(resolveRelativeJs("src/m.ts", "./nope", files)).toBeUndefined();
  });
  it("normalizes npm package names", () => {
    expect(npmPackageName("@a/b/c")).toBe("@a/b");
    expect(npmPackageName("lodash/fp")).toBe("lodash");
  });
  it("resolves python relative, absolute, external and stdlib", () => {
    const pf = new Set(["w/main.py", "w/jobs.py", "w/pkg/__init__.py"]);
    expect(resolvePython("w/main.py", ".jobs", ["run"], [""], pf).targets).toEqual(["w/jobs.py"]);
    expect(resolvePython("w/main.py", "w.pkg", [], [""], pf).targets).toEqual([
      "w/pkg/__init__.py",
    ]);
    expect(resolvePython("w/main.py", "requests", [], [""], pf).external).toBe("requests");
    expect(resolvePython("w/main.py", "os.path", [], [""], pf).stdlib).toBe(true);
    expect(resolvePython("w/main.py", ".missing", [], [""], pf).unresolved).toBe(true);
  });
});

describe("scan fixture", () => {
  it("produces a valid, deterministic model with the expected structure", async () => {
    const a = await scan(FIXTURE, { now: NOW });
    const b = await scan(FIXTURE, { now: NOW });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(validateModel(a)).toMatchObject({ ok: true });

    const ids = new Set(a.nodes.map((n) => n.id));
    for (const id of [
      "module:packages/api",
      "module:packages/api/src/routes",
      "module:packages/api/src/services",
      "module:packages/shared",
      "module:services/worker",
      "module:services/worker/worker",
      "file:packages/api/src/server.ts",
      "external:express",
      "external:stripe",
      "external:requests",
      "external:redis",
      "unresolved:./missing.js",
    ]) {
      expect(ids, id).toContain(id);
    }
    // Node builtins and python stdlib are not nodes.
    expect(ids).not.toContain("external:node:fs");
    expect(ids).not.toContain("external:os");
  });

  it("links files, workspace packages and detects both directions of the cycle", async () => {
    const m = await scan(FIXTURE, { now: NOW });
    const edges = new Set(m.edges.map((e) => e.id));
    const o = "file:packages/api/src/services/orders.ts";
    const bl = "file:packages/api/src/services/billing.ts";
    expect(edges).toContain(`${o}->imports->${bl}`);
    expect(edges).toContain(`${bl}->imports->${o}`);
    expect(edges).toContain("file:packages/api/src/server.ts->depends-on->module:packages/shared");
    expect(edges).toContain(
      "file:services/worker/worker/main.py->imports->file:services/worker/worker/jobs.py",
    );
    expect(edges).toContain(
      "file:services/worker/worker/main.py->imports->file:services/worker/worker/helpers.py",
    );
  });

  it("gives every import edge a line-level source anchor", async () => {
    const m = await scan(FIXTURE, { now: NOW });
    const e = m.edges.find((x) => x.id.includes("server.ts->depends-on->external:express"));
    expect(e?.evidence[0]).toMatchObject({
      kind: "verified",
      file: "packages/api/src/server.ts",
      startLine: 1,
    });
  });
});

describe("external dependency ecosystems", () => {
  it("records npm vs pypi on external nodes so research can pick the right registry", async () => {
    const m = await scan(FIXTURE, { now: NOW });
    const eco = (id: string) => m.nodes.find((n) => n.id === id)?.meta?.ecosystem;
    expect(eco("external:express")).toBe("npm");
    expect(eco("external:stripe")).toBe("npm");
    expect(eco("external:requests")).toBe("pypi");
    expect(eco("external:redis")).toBe("pypi");
  });
});

import { imageRepo, parseCpu, parseMemoryMb, scanTerraform } from "../src/index.js";

const INFRA = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../fixtures/infra-app",
);

describe("infrastructure detection", () => {
  it("parses sizes and image names", () => {
    expect(parseCpu("250m")).toBe(0.25);
    expect(parseCpu("0.5")).toBe(0.5);
    expect(parseMemoryMb("512Mi")).toBe(512);
    expect(parseMemoryMb("1Gi")).toBe(1024);
    expect(parseMemoryMb("512M")).toBe(512);
    expect(parseMemoryMb("lots")).toBeUndefined();
    expect(imageRepo("docker.io/library/postgres:16-alpine")).toEqual({
      repo: "library/postgres",
      tag: "16-alpine",
    });
    expect(imageRepo("ghcr.io/acme/web:1.2")).toEqual({ repo: "acme/web", tag: "1.2" });
  });

  it("scans Terraform blocks without evaluating expressions", () => {
    const [a, b] = scanTerraform(
      'resource "aws_db_instance" "x" {\n  instance_class = "db.t4g.small"\n  tags = { a = "b" }\n}\nresource "aws_s3_bucket" "y" {\n  bucket = var.name\n}\n',
    );
    expect(a).toMatchObject({ type: "aws_db_instance", name: "x", line: 1 });
    expect(a!.attrs.get("instance_class")).toBe("db.t4g.small");
    expect(a!.attrs.has("a")).toBe(false); // nested block attributes are not top-level
    expect(b!.attrs.get("bucket")).toBe("var.name");
  });

  it("finds services from compose, Dockerfiles, Terraform, Kubernetes, platforms, SDKs and env names", async () => {
    const m = await scan(INFRA, { now: NOW });
    expect(m.schemaVersion).toBe("buildrax-ir/v2");
    expect(validateModel(m)).toMatchObject({ ok: true });
    const infra = m.nodes
      .filter((n) => n.meta?.infra)
      .map((n) => n.id)
      .sort();
    expect(infra).toEqual(
      [
        "cache:redis",
        "compute:k8s-web",
        "compute:load-balancer",
        "compute:svc-api",
        "compute:svc-worker",
        "compute:tf-api",
        "database:postgres",
        "email:sendgrid",
        "hosting:vercel",
        "llm:openai",
        "messaging:twilio",
        "payments:stripe",
        "queue:celery",
        "storage:s3",
      ].sort(),
    );
    expect(m.meta.stats?.infra).toBe(14);
  });

  it("merges one service seen in many places, with Terraform sizes winning", async () => {
    const m = await scan(INFRA, { now: NOW });
    const db = m.nodes.find((n) => n.id === "database:postgres")!;
    expect(db.name).toBe("Amazon RDS");
    expect(db.meta).toMatchObject({
      engine: "postgres",
      version: "16.3",
      instanceType: "db.t4g.small",
      storageGb: 20,
      multiAz: false,
      provider: "aws",
    });
    expect(db.meta?.sources).toEqual(["compose", "env", "sdk", "terraform"]);
    // a size held in a variable (var.replica_class) is never treated as a size
    expect(JSON.stringify(db.meta)).not.toContain("replica_class");
    expect(db.evidence.map((e) => `${e.file}:${e.startLine}`)).toEqual(
      expect.arrayContaining([
        "docker-compose.yml:19",
        "infra/main.tf:1",
        "src/db.ts:1",
        "worker/tasks.py:2",
      ]),
    );
    const cache = m.nodes.find((n) => n.id === "cache:redis")!;
    expect(cache.meta).toMatchObject({ instanceType: "cache.t4g.micro", replicas: 1 });
  });

  it("records compute sizes from compose, ECS, Kubernetes and Dockerfiles", async () => {
    const m = await scan(INFRA, { now: NOW });
    const meta = (id: string) => m.nodes.find((n) => n.id === id)?.meta;
    expect(meta("compute:svc-api")).toMatchObject({
      replicas: 2,
      cpu: 0.5,
      memoryMb: 512,
      runtime: "node:20-alpine",
    });
    expect(meta("compute:svc-worker")).toMatchObject({ runtime: "python:3.12-slim" });
    expect(meta("compute:tf-api")).toMatchObject({
      cpu: 0.5,
      memoryMb: 1024,
      replicas: 2,
      provider: "aws",
    });
    expect(meta("compute:k8s-web")).toMatchObject({
      replicas: 3,
      cpu: 0.25,
      memoryMb: 512,
      image: "ghcr.io/acme/web:1.2",
    });
  });

  it("links code and services to the infrastructure they use", async () => {
    const m = await scan(INFRA, { now: NOW });
    const edges = new Map(m.edges.map((e) => [e.id, e]));
    expect(edges.get("file:src/db.ts->uses->database:postgres")?.evidence[0]).toMatchObject({
      kind: "verified",
      file: "src/db.ts",
      startLine: 1,
    });
    expect(edges.has("file:worker/tasks.py->uses->database:postgres")).toBe(true);
    expect(edges.has("file:worker/tasks.py->uses->queue:celery")).toBe(true);
    expect(edges.has("compute:svc-api->uses->database:postgres")).toBe(true);
    expect(edges.has("compute:svc-api->uses->cache:redis")).toBe(true);
  });

  it("marks services seen only through env variable names as inferred", async () => {
    const m = await scan(INFRA, { now: NOW });
    const twilio = m.nodes.find((n) => n.id === "messaging:twilio")!;
    expect(twilio.evidence.every((e) => e.kind === "inferred")).toBe(true);
    expect(twilio.meta?.confidence).toBe(0.4);
    expect(
      m.nodes.find((n) => n.id === "llm:openai")!.evidence.some((e) => e.kind === "verified"),
    ).toBe(true);
  });

  it("never reads a real .env file or any variable value", async () => {
    const m = await scan(INFRA, { now: NOW });
    const json = JSON.stringify(m);
    expect(json).not.toContain("not-a-real-secret");
    expect(json).not.toMatch(/"file":"\.env"/);
  });

  it("is deterministic", async () => {
    expect(JSON.stringify(await scan(INFRA, { now: NOW }))).toBe(
      JSON.stringify(await scan(INFRA, { now: NOW })),
    );
  });
});
