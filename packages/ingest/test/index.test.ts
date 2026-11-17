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
