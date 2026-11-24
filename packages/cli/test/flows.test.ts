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
    expect(text).toMatch(/GET\s+\/api\/orders\s+nextjs\s+web\/src\/app\/api\/orders\/route\.ts:2/);
    expect(text).toMatch(/\(computed path\)/);
  });

  it("follows an endpoint through an @/ alias to the database it uses", async () => {
    const { flows } = await flowCommand(tmp, "GET /api/orders");
    const next = flows.find((f) => f.route.framework === "nextjs")!;
    expect(next.participants.infra).toEqual(["database:postgres"]);
    const text = await formatFlows(tmp, flows, "GET /api/orders");
    expect(text).toMatch(/web\/src\/lib\/db\.ts -uses-> PostgreSQL \[database\]/);
    expect(text).toMatch(/not one runtime path/);
  });

  it("answers which endpoints reach a database", async () => {
    const hits = await routesCommand(tmp, { reaching: "database:postgres" });
    expect(hits.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /api/orders",
      "POST /api/orders",
      "DELETE /api/orders/:id",
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
