import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { scanDetailed } from "@buildrax/ingest";
import type { ResearchFile } from "@buildrax/ir";
import { buildDesign, type DesignModel } from "../src/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => path.resolve(here, "../../../fixtures", name);
const NOW = { now: "2026-11-28T00:00:00.000Z", git: false };

let flows: DesignModel;
let infra: DesignModel;
let flowsInput: Awaited<ReturnType<typeof scanDetailed>>;
beforeAll(async () => {
  flowsInput = await scanDetailed(fixture("flows-app"), NOW);
  flows = buildDesign(flowsInput);
  const i = await scanDetailed(fixture("infra-app"), NOW);
  infra = buildDesign(i);
});

const el = (d: DesignModel, id: string) => d.c4.elements.find((e) => e.id === id)!;
const rel = (d: DesignModel, from: string, to: string) =>
  d.c4.relations.find((r) => r.from === from && r.to === to);

describe("C4 projection", () => {
  it("makes containers of packages and serving folders, with data stores and people", () => {
    const containers = flows.c4.elements
      .filter((e) => e.level === 2)
      .map((e) => `${e.kind} ${e.name}`);
    expect(containers).toEqual([
      "app api",
      "app edge",
      "app flask",
      "app nest",
      "app py",
      "app web",
      "datastore Redis",
      "datastore PostgreSQL",
      "queue BullMQ (Redis)",
      "queue Celery workers",
    ]);
    expect(el(flows, "c4:container:module:web")).toMatchObject({
      technology: ["nextjs", "typescript"],
      description: "Application (nextjs, typescript): 4 endpoints, 1 page, 8 files.",
      tags: ["data access", "endpoints", "messaging", "pages", "worker"],
      provenance: "code",
    });
    expect(el(flows, "c4:person:api-clients").provenance).toBe("inferred");
    expect(rel(flows, "c4:person:api-clients", "c4:container:module:web")?.label).toBe(
      "4 endpoints",
    );
    expect(rel(flows, "c4:person:web-users", "c4:container:module:web")?.label).toBe("1 page");
  });

  it("aggregates data operations into labelled relationships at levels 2 and 3", () => {
    expect(rel(flows, "c4:container:module:web", "c4:store:database:postgres")).toMatchObject({
      label: "reads, writes (orders)",
      kinds: ["reads", "writes"],
      provenance: "code",
    });
    expect(rel(flows, "c4:container:module:web", "c4:store:queue:bullmq")?.label).toBe(
      "consumes, publishes (emails)",
    );
    expect(rel(flows, "c4:component:module:web/src/worker", "c4:store:queue:bullmq")?.label).toBe(
      "consumes (emails)",
    );
    expect(
      rel(flows, "c4:component:module:web/src/app", "c4:component:module:web/src/lib")?.label,
    ).toBe("imports (4)");
    expect(el(flows, "c4:component:module:web/src/worker")).toMatchObject({
      tags: ["data access", "worker"],
      files: 1,
      functions: 1,
    });
  });

  it("ties compose services to the folder they build, and lists the rest as deployment", () => {
    expect(el(infra, "c4:container:module:.").deployedAs).toEqual(["compute:svc-api"]);
    expect(el(infra, "c4:container:module:worker")).toMatchObject({
      kind: "service",
      deployedAs: ["compute:svc-worker"],
    });
    expect(infra.c4.deployment).toEqual([
      "compute:k8s-web",
      "compute:load-balancer",
      "compute:tf-api",
      "hosting:vercel",
    ]);
    expect(el(infra, "c4:ext:payments:stripe")).toMatchObject({
      level: 1,
      kind: "external-system",
    });
    expect(rel(infra, "c4:system", "c4:ext:payments:stripe")?.label).toBe("uses");
    expect(rel(infra, "c4:container:module:worker", "c4:store:database:postgres")?.kinds).toEqual([
      "uses",
    ]);
  });
});

describe("concepts", () => {
  it("finds patterns from code and config, with evidence and the docs about them", () => {
    const ids = flows.concepts.map((c) => c.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "rest-api",
        "health-check",
        "relational-database",
        "orm",
        "caching",
        "cache-aside",
        "message-queue",
        "background-workers",
        "monorepo",
      ]),
    );
    const ca = flows.concepts.find((c) => c.id === "cache-aside")!;
    expect(ca.detail).toContain("GET (web/src/app/api/orders/route.ts:4)");
    expect(ca.evidence[0]).toMatchObject({ file: "web/src/app/api/orders/route.ts", startLine: 4 });
    expect(flows.concepts.find((c) => c.id === "relational-database")?.documentedBy).toEqual([
      "adr:docs/adr/0001-postgres-for-orders.md",
    ]);
    const deploy = infra.concepts.filter((c) => c.category === "Deployment").map((c) => c.id);
    expect(deploy).toEqual([
      "containers",
      "orchestration",
      "iac",
      "managed-platform",
      "load-balancing",
      "replicas",
    ]);
  });
});

describe("NFR scorecard", () => {
  it("reports present, absent and risk with evidence, never a grade", () => {
    const check = (id: string) => flows.scorecard.checks.find((c) => c.id === id)!;
    expect(check("performance:cache-aside-reads")).toMatchObject({
      status: "present",
      concept: "cache-aside",
    });
    expect(check("security:rate-limiting")).toMatchObject({
      status: "absent",
      provenance: "inferred",
    });
    expect(check("security:known-advisories").status).toBe("unknown");
    expect(check("data:shared-database:database:postgres")).toMatchObject({
      status: "risk",
      detail: "2 containers write to it (py, web); schema changes must be coordinated across them.",
    });
    const data = flows.scorecard.summary.find((s) => s.category === "Data")!;
    expect(data).toEqual({ category: "Data", present: 1, absent: 1, risk: 1, unknown: 0 });
  });

  it("uses research findings when they exist", () => {
    const research: ResearchFile = {
      schemaVersion: "buildrax-research/v2",
      generatedAt: "2026-11-01T00:00:00.000Z",
      errors: [],
      findings: [
        {
          id: "f1",
          nodeId: "external:next",
          subject: "next",
          finding: "GHSA-x [high]: something",
          sourceUrl: "https://osv.dev/vulnerability/GHSA-x",
          publisher: "OSV.dev",
          retrievedAt: "2026-11-01",
          evidenceType: "advisory",
          reliability: "high",
        },
      ],
    };
    const d = buildDesign({ ...flowsInput, research });
    const adv = d.scorecard.checks.find((c) => c.id === "security:known-advisories")!;
    expect(adv).toMatchObject({
      status: "risk",
      provenance: "researched",
      where: ["external:next"],
    });
    expect(d.scorecard.checks.find((c) => c.id === "security:supported-runtimes")?.status).toBe(
      "present",
    );
  });
});

describe("design package", () => {
  it("is deterministic", () => {
    expect(buildDesign(flowsInput)).toEqual(flows);
  });
  it("stays browser-safe (no node: imports in src)", () => {
    const dir = path.resolve(here, "../src");
    for (const f of readdirSync(dir))
      expect(readFileSync(path.join(dir, f), "utf8")).not.toMatch(/from "node:/);
  });
});
