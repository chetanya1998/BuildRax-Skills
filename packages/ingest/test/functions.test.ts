import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validateFunctions, type FnEntry, type FunctionsFile } from "@buildrax/ir";
import { parseFile, scanDetailed } from "../src/index.js";

const fnsOf = async (src: string, lang: "typescript" | "python") =>
  (await parseFile(src, lang)).facts.functions ?? [];

describe("functions in source", () => {
  it("names functions, methods, arrows and inline callbacks; skips one-expression callbacks", async () => {
    const fns = await fnsOf(
      [
        "export async function load(id) { return find(id); }",
        "export class Repo {",
        "  async find(id) { return this.db.get(id); }",
        "}",
        "export const save = async (x) => { await db.put(x); await db.put(x); };",
        'router.get("/orders", async (req, res) => { res.json(await load(1)); });',
        'new Worker("emails", async (job) => { await send(job); });',
        "const ids = rows.map((r) => r.id);",
        "function outer() { function inner() { go(); } inner(); }",
      ].join("\n"),
      "typescript",
    );
    expect(fns.map((f) => [f.name, f.kind, !!f.exported, !!f.async])).toEqual([
      ["load", "function", true, true],
      ["Repo.find", "method", true, true],
      ["save", "arrow", true, true],
      ['router.get("/orders")', "callback", false, true],
      ['new Worker("emails")', "callback", false, true],
      ["outer", "function", false, false],
      ["outer.inner", "function", false, false],
    ]);
    expect(fns[2]!.calls).toEqual([{ callee: "db.put", line: 5, count: 2 }]);
    expect(fns[1]!.calls.map((c) => c.callee)).toEqual(["this.db.get"]);
    // Calls belong to the innermost function only.
    expect(fns[5]!.calls.map((c) => c.callee)).toEqual(["inner"]);
    expect(fns[6]!.calls.map((c) => c.callee)).toEqual(["go"]);
  });

  it("names Python functions and class methods, with calls", async () => {
    const fns = await fnsOf(
      [
        "class Job:",
        "    def run(self):",
        "        self.step()",
        "    async def step(self):",
        "        def inner():",
        "            pass",
        "        inner()",
        "def _private():",
        "    work.delay(1)",
      ].join("\n"),
      "python",
    );
    expect(fns.map((f) => [f.name, f.kind, f.line, f.endLine, !!f.exported, !!f.async])).toEqual([
      ["Job.run", "method", 2, 3, false, false],
      ["Job.step", "method", 4, 7, false, true],
      ["Job.step.inner", "function", 5, 6, false, false],
      ["_private", "function", 8, 9, false, false],
    ]);
    expect(fns[3]!.calls).toEqual([{ callee: "work.delay", line: 9 }]);
  });
});

const write = async (root: string, files: Record<string, string>) => {
  for (const [p, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, p)), { recursive: true });
    await fs.writeFile(path.join(root, p), text);
  }
};

let tmp: string;
let index: FunctionsFile;
const fn = (id: string): FnEntry => {
  const hit = index.files.flatMap((f) => f.functions).find((f) => f.id === id);
  if (!hit) throw new Error(`no ${id}`);
  return hit;
};

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "buildrax-fn-"));
  await write(tmp, {
    "package.json": JSON.stringify({ name: "root", private: true, workspaces: ["packages/*"] }),
    "packages/core/package.json": JSON.stringify({ name: "@t/core" }),
    "packages/core/src/index.ts": [
      "export function total(xs: number[]) { return sum(xs); }",
      "function sum(xs: number[]) { return xs.length; }",
      "export class Cart {",
      "  add(x: number) { this.save(x); }",
      "  save(x: number) { return x; }",
      "}",
    ].join("\n"),
    "packages/app/package.json": JSON.stringify({
      name: "@t/app",
      dependencies: { "@t/core": "*", stripe: "1.0.0", express: "4.0.0" },
    }),
    "packages/app/src/util.ts": "export function fmt(n: number) { return String(n); }\n",
    "packages/app/src/main.ts": [
      'import express from "express";',
      'import Stripe from "stripe";',
      'import { total } from "@t/core";',
      'import * as util from "./util";',
      'import { fmt } from "./util";',
      "const app = express();",
      "export async function run() {",
      "  total([1]);",
      "  util.fmt(1);",
      "  fmt(2);",
      "  fmt(3);",
      '  const s = new Stripe("k");',
      "  helper();",
      "  console.log(s);",
      "}",
      "const helper = () => 1;",
      'app.get("/x", async (req, res) => { await run(); res.send("ok"); });',
    ].join("\n"),
    "app/__init__.py": "",
    "app/tasks.py": "def work():\n    pass\n",
    "app/jobs.py": [
      "from app.tasks import work",
      "class Job:",
      "    def run(self):",
      "        self.step()",
      "        work.delay()",
      "    def step(self):",
      "        def inner():",
      "            pass",
      "        inner()",
    ].join("\n"),
  });
  index = (await scanDetailed(tmp, { now: "2026-11-28T00:00:00.000Z" })).functions;
});
afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("function index", () => {
  it("is valid and deterministic, with unique ids", async () => {
    expect(validateFunctions(index)).toMatchObject({ ok: true });
    const ids = index.files.flatMap((f) => f.functions.map((x) => x.id));
    expect(new Set(ids).size).toBe(ids.length);
    const again = (await scanDetailed(tmp, { now: "2026-11-28T00:00:00.000Z" })).functions;
    expect(again).toEqual(index);
  });

  it("resolves calls: local, imported, namespace, workspace package and external", () => {
    const run = fn("fn:packages/app/src/main.ts#run");
    expect(run.calls.map((c) => [c.name, c.via, c.to, c.count ?? 1])).toEqual([
      ["total", "workspace", "fn:packages/core/src/index.ts#total", 1],
      ["util.fmt", "import", "fn:packages/app/src/util.ts#fmt", 1],
      ["fmt", "import", "fn:packages/app/src/util.ts#fmt", 2],
      ["new Stripe", "external", "external:stripe", 1],
      ["helper", "local", "fn:packages/app/src/main.ts#helper", 1],
    ]);
    expect(run.otherCalls).toBe(1); // console.log
    expect(fn("fn:packages/core/src/index.ts#Cart.add").calls[0]).toMatchObject({
      to: "fn:packages/core/src/index.ts#Cart.save",
      via: "local",
    });
  });

  it("records callers, route handlers and Python calls", () => {
    expect(fn("fn:packages/app/src/util.ts#fmt").calledBy).toEqual([
      "fn:packages/app/src/main.ts#run",
    ]);
    const cb = fn('fn:packages/app/src/main.ts#app.get("/x")');
    expect(cb.routes?.length).toBe(1);
    expect(cb.calls[0]).toMatchObject({ name: "run", via: "local" });
    expect(fn("fn:packages/app/src/main.ts#run").calledBy).toEqual([cb.id]);
    expect(fn("fn:app/jobs.py#Job.run").calls.map((c) => [c.name, c.to])).toEqual([
      ["self.step", "fn:app/jobs.py#Job.step"],
      ["work.delay", "fn:app/tasks.py#work"],
    ]);
    expect(fn("fn:app/jobs.py#Job.step").calls[0]!.to).toBe("fn:app/jobs.py#Job.step.inner");
  });
});

describe("function index on the flows fixture", () => {
  it("puts proven data operations and routes in the functions that hold them", async () => {
    const fixture = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../../fixtures/flows-app",
    );
    const { functions } = await scanDetailed(fixture, { now: "2026-11-28T00:00:00.000Z" });
    index = functions;
    const get = fn("fn:web/src/app/api/orders/route.ts#GET");
    expect(get.routes).toEqual(["route:web:GET /api/orders"]);
    expect(get.ops.map((o) => `${o.kind} ${o.to} :${o.line}`)).toEqual([
      "reads cache:redis :5",
      "reads database:postgres :7",
      "writes cache:redis :8",
    ]);
    const worker = fn('fn:web/src/worker/emails.ts#new Worker("emails")');
    expect(worker.ops.map((o) => o.kind)).toEqual(["consumes", "writes"]);
    expect(fn("fn:py/app/tasks.py#send_receipt").calledBy).toEqual([
      "fn:py/app/routers/items.py#bulk",
    ]);
  });
});
