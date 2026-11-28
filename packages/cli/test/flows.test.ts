import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  flowCommand,
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
