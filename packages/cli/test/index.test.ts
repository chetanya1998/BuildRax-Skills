import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validateModel } from "@buildrax/ir";
import { formatSummary, scanCommand, viewCommand } from "../src/index.js";

const FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../fixtures/sample-monorepo",
);
let tmp: string;

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "buildrax-cli-"));
  await fs.cp(FIXTURE, tmp, { recursive: true });
});
afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("cli commands", () => {
  it("scan writes a valid model and reports the circular dependency", async () => {
    const summary = await scanCommand(tmp);
    const written = JSON.parse(
      await fs.readFile(path.join(tmp, ".buildrax", "model.json"), "utf8"),
    );
    expect(validateModel(written).ok).toBe(true);
    expect(summary.cycles).toHaveLength(1);
    expect(formatSummary(summary)).toContain("1 circular dependency");
    expect(await fs.readFile(path.join(tmp, ".buildrax", ".gitignore"), "utf8")).toContain(
      "view.html",
    );
  });

  it("view embeds the model into a standalone html file", async () => {
    await scanCommand(tmp);
    const out = await viewCommand(tmp);
    const html = await fs.readFile(out, "utf8");
    expect(html).toContain('id="buildrax-data"');
    expect(html).toContain("buildrax-ir/v1");
  });

  it("view fails helpfully when no model exists", async () => {
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), "buildrax-empty-"));
    await expect(viewCommand(empty)).rejects.toThrow(/buildrax scan/);
    await fs.rm(empty, { recursive: true, force: true });
  });
});

import http from "node:http";
import { emptyNotes, type Note } from "@buildrax/ir";
import { notesCommand, notesPathFor, startServer, type RunningServer } from "../src/index.js";

const sampleNote = (over: Partial<Note> = {}): Note => ({
  id: "n1",
  target: { type: "node", id: "file:packages/api/src/server.ts" },
  type: "flag",
  color: "red",
  body: "check auth here",
  createdAt: "t",
  updatedAt: "t",
  ...over,
});

describe("notes via cli", () => {
  it("lists open notes and reports orphans without touching the file", async () => {
    const file = notesPathFor(tmp);
    await fs.writeFile(
      file,
      JSON.stringify({
        ...emptyNotes(),
        notes: [
          sampleNote(),
          sampleNote({ id: "n2", target: { type: "node", id: "file:gone.ts" } }),
          sampleNote({ id: "n3", resolved: true }),
        ],
      }),
    );
    const before = await fs.readFile(file, "utf8");
    const r = await notesCommand(tmp);
    expect(r.open.map((n) => n.id)).toEqual(["n1"]);
    expect(r.orphaned.map((n) => n.id)).toEqual(["n2"]);
    expect(r.resolved).toBe(1);
    expect(await fs.readFile(file, "utf8")).toBe(before);
  });

  it("refuses a corrupt notes file instead of overwriting it", async () => {
    await fs.writeFile(notesPathFor(tmp), "{nope");
    await expect(notesCommand(tmp)).rejects.toThrow(/not valid JSON/);
    await fs.rm(notesPathFor(tmp));
  });
});

describe("serve", () => {
  let server: RunningServer;
  beforeAll(async () => {
    await scanCommand(tmp);
    server = await startServer(tmp, 0);
  });
  afterAll(async () => server.close());

  const call = (
    path: string,
    init: { method?: string; headers?: Record<string, string>; body?: string } = {},
  ) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const u = new URL(server.url);
      const req = http.request(
        {
          host: u.hostname,
          port: u.port,
          path,
          method: init.method ?? "GET",
          headers: { host: u.host, ...init.headers },
        },
        (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        },
      );
      req.on("error", reject);
      req.end(init.body);
    });
  const auth = (): Record<string, string> => ({ "x-buildrax-token": server.token });

  it("serves the viewer with the model, notes and a session token", async () => {
    const r = await call("/");
    expect(r.status).toBe(200);
    expect(r.body).toContain("buildrax-ir/v1");
    expect(r.body).toContain(server.token);
  });

  it("round-trips notes to .buildrax/notes.json atomically", async () => {
    const put = await call("/api/notes", {
      method: "PUT",
      headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify({ ...emptyNotes(), notes: [sampleNote()] }),
    });
    expect(put.status).toBe(200);
    expect(JSON.parse(await fs.readFile(notesPathFor(tmp), "utf8")).notes).toHaveLength(1);
    const get = await call("/api/notes", { headers: auth() });
    expect(JSON.parse(get.body).notes[0].body).toBe("check auth here");
    await expect(fs.access(`${notesPathFor(tmp)}.tmp`)).rejects.toThrow();
  });

  it("rejects missing token, bad host, bad origin, wrong content type and invalid bodies", async () => {
    expect((await call("/api/notes")).status).toBe(401);
    expect(
      (await call("/api/notes", { headers: { ...auth(), host: "evil.example" } })).status,
    ).toBe(403);
    expect(
      (await call("/api/notes", { headers: { ...auth(), origin: "http://evil.example" } })).status,
    ).toBe(403);
    expect(
      (
        await call("/api/notes", {
          method: "PUT",
          headers: { ...auth(), "content-type": "text/plain" },
          body: "{}",
        })
      ).status,
    ).toBe(415);
    const bad = await call("/api/notes", {
      method: "PUT",
      headers: { ...auth(), "content-type": "application/json" },
      body: '{"schemaVersion":"x"}',
    });
    expect(bad.status).toBe(400);
  });

  it("does not serve files from disk", async () => {
    expect((await call("/../../etc/passwd")).status).toBe(404);
    expect((await call("/package.json")).status).toBe(404);
  });
});

import { traceModel } from "../src/index.js";
import { scan } from "@buildrax/ingest";

describe("trace", () => {
  it("finds what depends on a file (impact) with evidence, and what it depends on", async () => {
    const m = await scan(FIXTURE, { now: "2026-01-01T00:00:00.000Z" });
    const up = traceModel(m, "packages/api/src/services/billing.ts", { direction: "up" });
    expect(up.hits.map((h) => h.path)).toEqual(
      expect.arrayContaining([
        "packages/api/src/services/orders.ts",
        "packages/api/src/routes/orders.ts",
        "packages/api/src/server.ts",
      ]),
    );
    const first = up.hits.find((h) => h.path === "packages/api/src/services/orders.ts")!;
    expect(first).toMatchObject({
      distance: 1,
      via: { evidence: { file: "packages/api/src/services/orders.ts", startLine: 1 } },
    });
    const down = traceModel(m, "billing.ts", { direction: "down", depth: 1 });
    expect(down.hits.map((h) => h.id)).toEqual(
      expect.arrayContaining(["external:stripe", "file:packages/api/src/services/orders.ts"]),
    );
    expect(down.hits.every((h) => h.distance === 1)).toBe(true);
  });
  it("rejects unknown targets with a helpful message", async () => {
    const m = await scan(FIXTURE, { now: "2026-01-01T00:00:00.000Z" });
    expect(() => traceModel(m, "zzz-nothing")).toThrow(/no node matches/);
  });
});

import { buildProgram } from "../src/index.js";
import { skillSourceDir } from "@buildrax/skills";

describe("skill stays in sync with the cli", () => {
  it("every `buildrax <command>` mentioned in the skill docs exists", async () => {
    const commands = new Set(buildProgram().commands.map((c) => c.name()));
    const root = skillSourceDir();
    const files = [
      "SKILL.md",
      "references/commands.md",
      "references/answering-questions.md",
      "references/limits.md",
    ];
    const mentioned = new Set<string>();
    for (const f of files) {
      const text = await fs.readFile(path.join(root, f), "utf8");
      for (const m of text.matchAll(/buildrax ([a-z][a-z-]+)/g)) mentioned.add(m[1]!);
    }
    // Words that follow "buildrax" in prose rather than naming a command.
    const prose = new Set([
      "install",
      "does",
      "did",
      "skill",
      "is",
      "to",
      "reports",
      "from",
      "cli",
      "cannot",
      "has",
      "output",
      "model",
      "will",
    ]);
    const unknown = [...mentioned].filter((m) => !commands.has(m) && !prose.has(m));
    expect(unknown).toEqual([]);
    for (const c of [
      "scan",
      "digest",
      "context",
      "trace",
      "view",
      "serve",
      "notes",
      "research",
      "install-skill",
    ]) {
      expect(commands.has(c), c).toBe(true);
    }
  });
});

import { collectSources, readModelFile } from "../src/commands/sources.js";

describe("source access for the Code tab", () => {
  it("embeds scanned source in a static view, safely inside the script tag", async () => {
    await scanCommand(tmp);
    await fs.writeFile(
      path.join(tmp, "packages/api/src/evil.ts"),
      'export const s = "</script><script>window.__x=1</script>";\n',
    );
    await scanCommand(tmp);
    const html = await fs.readFile(await viewCommand(tmp), "utf8");
    expect(html).toContain("import Stripe");
    expect(html).not.toContain("</script><script>window.__x=1</script>");
    const tag = /<script id="buildrax-sources" type="application\/json">([\s\S]*?)<\/script>/.exec(
      html,
    )![1]!;
    expect(JSON.parse(tag)["packages/api/src/evil.ts"]).toContain("</script>");
    await fs.rm(path.join(tmp, "packages/api/src/evil.ts"));
    await scanCommand(tmp);
  });

  it("omits source with --no-source", async () => {
    await scanCommand(tmp);
    const html = await fs.readFile(await viewCommand(tmp, { source: false }), "utf8");
    expect(html).not.toContain("import Stripe");
  });

  it("only reads files that are nodes of the model, inside the repo", async () => {
    await scanCommand(tmp);
    const model = JSON.parse(await fs.readFile(path.join(tmp, ".buildrax", "model.json"), "utf8"));
    expect(await readModelFile(tmp, model, "packages/api/src/server.ts")).toContain("express");
    for (const bad of [
      "../../etc/passwd",
      "/etc/passwd",
      "package.json",
      ".buildrax/model.json",
      "packages/api/package.json",
      "nope.ts",
    ]) {
      expect(await readModelFile(tmp, model, bad), bad).toBeUndefined();
    }
    // A symlink inside the repo pointing outside must not be followed.
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "brx-out-"));
    await fs.writeFile(path.join(outside, "secret.ts"), "secret");
    await fs.symlink(path.join(outside, "secret.ts"), path.join(tmp, "packages/api/src/link.ts"));
    const withLink = {
      ...model,
      nodes: [
        ...model.nodes,
        {
          id: "file:packages/api/src/link.ts",
          kind: "file",
          name: "link.ts",
          path: "packages/api/src/link.ts",
          evidence: [{ kind: "verified" }],
        },
      ],
    };
    expect(await readModelFile(tmp, withLink, "packages/api/src/link.ts")).toBeUndefined();
    expect((await collectSources(tmp, withLink)).omitted).toContain("packages/api/src/link.ts");
    await fs.rm(path.join(tmp, "packages/api/src/link.ts"));
    await fs.rm(outside, { recursive: true, force: true });
  });
});

describe("serve /api/file", () => {
  let server: RunningServer;
  beforeAll(async () => {
    await scanCommand(tmp);
    server = await startServer(tmp, 0);
  });
  afterAll(async () => server.close());
  const get = (p: string, token: string | null = server.token) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const u = new URL(server.url);
      http
        .get(
          {
            host: u.hostname,
            port: u.port,
            path: p,
            headers: token ? { "x-buildrax-token": token } : {},
          },
          (res) => {
            let body = "";
            res.on("data", (c) => (body += c));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
          },
        )
        .on("error", reject);
    });

  it("serves scanned files with a token and nothing else", async () => {
    const ok = await get("/api/file?path=packages/api/src/server.ts");
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body).text).toContain("express");
    expect((await get("/api/file?path=packages/api/src/server.ts", null)).status).toBe(401);
    for (const bad of [
      "../../../etc/passwd",
      "%2e%2e%2f%2e%2e%2fetc%2fpasswd",
      "package.json",
      ".buildrax%2Fnotes.json",
      "",
    ]) {
      expect((await get(`/api/file?path=${bad}`)).status, bad).toBe(404);
    }
  });
});
