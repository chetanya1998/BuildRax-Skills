import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  checkReview,
  importCommand,
  loadReview,
  packCommand,
  reviewPathFor,
  designCommand,
  formatDesign,
  decisionsCommand,
  formatDecisions,
  formatWhy,
  whyCommand,
  flowCommand,
  formatFunctions,
  functionsCommand,
  formatFlows,
  formatRoutes,
  routesCommand,
  scanCommand,
} from "../src/index.js";

const FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../fixtures/flows-app",
);
let tmp: string;
beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "buildrax-flows-"));
  await fs.cp(FIXTURE, tmp, { recursive: true });
  await scanCommand(tmp);
});
afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("routes and flow commands", () => {
  it("lists endpoints with framework and file:line", async () => {
    const text = formatRoutes(await routesCommand(tmp));
    expect(text).toMatch(/^22 API endpoint\(s\), 1 page\(s\)/);
    expect(text).toMatch(/GET\s+\/api\/orders\s+nextjs\s+web\/src\/app\/api\/orders\/route\.ts:4/);
    expect(text).toMatch(/\(computed path\)/);
  });

  it("follows an endpoint through @/ aliases to what it reads and writes", async () => {
    const { flows } = await flowCommand(tmp, "GET /api/orders");
    const next = flows.find((f) => f.route.framework === "nextjs")!;
    expect(next.participants.infra).toEqual(["cache:redis", "database:postgres", "queue:bullmq"]);
    const text = await formatFlows(tmp, flows, "GET /api/orders");
    expect(text).toMatch(/route\.ts -reads-> Redis \[cache\] \(orders:all\)/);
    expect(text).toMatch(/route\.ts -reads-> PostgreSQL \[database\] \(orders\)/);
    // POST's insert and queue publish belong to POST, not to GET
    expect(text).not.toMatch(/route\.ts -publishes->/);
    expect(text).toMatch(/not one runtime path/);
  });

  it("continues through a queue to the worker that consumes it", async () => {
    const { flows } = await flowCommand(tmp, "POST /api/orders");
    const text = await formatFlows(tmp, flows, "POST /api/orders");
    expect(text).toMatch(/route\.ts -publishes-> BullMQ \(Redis\) \[queue\] \(emails\)/);
    expect(text).toMatch(
      /BullMQ \(Redis\) \[queue\] -delivers-> web\/src\/worker\/emails\.ts \(emails\) \[async\]/,
    );
    expect(text).toMatch(/worker\/emails\.ts -writes-> PostgreSQL \[database\] \(orders\)/);
  });

  it("answers which endpoints reach a database", async () => {
    const hits = await routesCommand(tmp, { reaching: "database:postgres" });
    expect(hits.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /",
      "GET /api/orders",
      "POST /api/orders",
      "DELETE /api/orders/:id",
      "GET /api/v1/items/{item_id}",
      "POST /api/v1/items/bulk",
      "PUT /api/v1/items/bulk",
    ]);
    await expect(routesCommand(tmp, { reaching: "nothing-like-this" })).rejects.toThrow(
      /nothing in the model/,
    );
  });

  it("explains when nothing matches", async () => {
    const { flows } = await flowCommand(tmp, "GET /nope");
    expect(await formatFlows(tmp, flows, "GET /nope")).toMatch(/No endpoint matches/);
  });
});

describe("fn command (function index)", () => {
  it("scan writes functions.json and fn lists a file's functions with ops and routes", async () => {
    await fs.access(path.join(tmp, ".buildrax", "functions.json"));
    const res = await functionsCommand(tmp, "web/src/app/api/orders/route.ts");
    expect(res.file).toBe("web/src/app/api/orders/route.ts");
    expect(res.functions.map((f) => f.name)).toEqual(["GET", "POST"]);
    const text = formatFunctions(res, "route.ts");
    expect(text).toContain("GET  4-10  (function, exported, async)");
    expect(text).toContain("handles GET /api/orders");
    expect(text).toContain("publishes queue:bullmq  :14");
    expect(text).not.toContain(" in POST");
  });

  it("finds a function by name and shows its callers", async () => {
    const res = await functionsCommand(tmp, "send_receipt");
    const text = formatFunctions(res, "send_receipt");
    expect(text).toContain("send_receipt  py/app/tasks.py:7-8");
    expect(text).toContain("called by bulk (py/app/routers/items.py)");
    expect(formatFunctions(await functionsCommand(tmp, "nope"), "nope")).toMatch(
      /^No function matches/,
    );
  });
});

describe("why and decisions commands (rationale)", () => {
  it("shows the decision record behind a file, with its provenance", async () => {
    await fs.access(path.join(tmp, ".buildrax", "rationale.json"));
    const res = await whyCommand(tmp, "web/src/lib/db.ts");
    expect(res.node.id).toBe("file:web/src/lib/db.ts");
    const text = formatWhy(res);
    expect(text).toContain("Documented (decision record) (1)");
    expect(text).toContain(
      "1. Store orders in PostgreSQL  (accepted, 2026-03-02)  docs/adr/0001-postgres-for-orders.md",
    );
    expect(text).toContain("not inferred");
  });

  it("quotes explaining comments and lists decision records", async () => {
    const text = formatWhy(await whyCommand(tmp, "web/src/lib/cache.ts"));
    expect(text).toContain("From code (1)");
    expect(text).toContain('"One shared client on purpose');
    const list = formatDecisions(await decisionsCommand(tmp));
    expect(list).toMatch(/^3 decision record\(s\)/);
    expect(list).toMatch(/superseded\s+ADR 2: Send emails from a worker/);
  });
});

describe("design command", () => {
  it("prints the C4 levels, concepts and scorecard with provenance", async () => {
    const d = await designCommand(tmp);
    expect(d.inputs).toEqual({ functions: true, rationale: true, research: false });
    const text = formatDesign(d, { level: 3 });
    expect(text).toContain("web -> PostgreSQL: reads, writes (orders)  (from code)");
    expect(text).toContain("API clients [person]");
    expect(text).toContain("    web/src/worker [data access, worker]  1 file(s), 1 function(s)");
    expect(text).toMatch(/Cache-aside: 1 function .* \(from code\)/);
    expect(text).toContain("! One service writes to PostgreSQL");
    expect(text).toContain("counts, not grades");
    expect(formatDesign(d, { level: 1 })).not.toContain("CONTAINERS");
  });
});

describe("design review loop (pack → agent → import)", () => {
  const review = (items: unknown[]) => ({
    schemaVersion: "buildrax-design-review/v1",
    agent: "t",
    items,
  });
  const good = {
    type: "risk",
    severity: "medium",
    title: "Two services write PostgreSQL",
    body: "py and web both write.",
    nodes: ["database:postgres", "c4:container:module:py"],
    evidence: [{ file: "./web/src/app/api/orders/route.ts", line: 13 }],
  };

  it("writes a brief with rules, citable ids and the output shape, and no notes", async () => {
    const { path: p, text } = await packCommand(tmp);
    expect(p).toBe(path.join(tmp, ".buildrax", "design-pack.md"));
    expect(text).toContain("`c4:store:database:postgres` PostgreSQL [datastore]");
    expect(text).toContain("1. Store orders in PostgreSQL (accepted)");
    expect(text).toContain('"schemaVersion": "buildrax-design-review/v1"');
    expect(text).toContain("RISK Data / One service writes to PostgreSQL");
    expect(text).not.toMatch(/notes\.json/);
  });

  it("rejects unknown ids, bad lines, private URLs and unknown concepts, storing nothing", async () => {
    const d = await designCommand(tmp);
    const model = JSON.parse(await fs.readFile(path.join(tmp, ".buildrax", "model.json"), "utf8"));
    const bad = checkReview(
      review([
        {
          ...good,
          nodes: ["database:nope"],
          evidence: [
            { file: "web/src/lib/db.ts", line: 999 },
            { file: "nope.ts", line: 1 },
          ],
          sources: [{ url: "https://127.0.0.1/x", accessed: "2026-11-28" }],
          concept: "made-up",
        },
      ]),
      model,
      d,
      "2026-11-28T00:00:00.000Z",
    );
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.errors).toEqual([
      'items.0.nodes: unknown id "database:nope"',
      "items.0.evidence: web/src/lib/db.ts has 3 lines, not 999",
      'items.0.evidence: "nope.ts" is not a scanned file',
      'items.0.sources: "https://127.0.0.1/x" must be a public https URL',
      'items.0.concept: unknown concept "made-up"',
    ]);
    expect(checkReview({ items: [] }, model, d, "t").ok).toBe(false);
    await expect(fs.access(reviewPathFor(tmp))).rejects.toThrow();
  });

  it("stores a valid review as AI inference and shows it in the design view", async () => {
    const file = path.join(tmp, "review.json");
    await fs.writeFile(
      file,
      JSON.stringify(
        review([
          good,
          {
            type: "rationale",
            title: "Why a queue",
            body: "Inferred.",
            nodes: ["queue:bullmq"],
            sources: [{ url: "https://docs.bullmq.io/", accessed: "2026-11-28" }],
          },
        ]),
      ),
    );
    const stored = await importCommand(tmp, file, "2026-11-28T00:00:00.000Z");
    expect(stored.items.map((i) => [i.id, i.provenance, i.cited])).toEqual([
      ["review:1", "ai", false],
      ["review:2", "ai", true],
    ]);
    expect(stored.items[0]!.evidence).toEqual([
      { file: "web/src/app/api/orders/route.ts", line: 13 },
    ]);
    const text = formatDesign(await designCommand(tmp), { review: await loadReview(tmp) });
    expect(text).toContain(
      "RISK [medium] Two services write PostgreSQL  (AI inference, unverified)",
    );
    expect(text).toContain("RATIONALE Why a queue  (AI inference, cited)");
  });
});
