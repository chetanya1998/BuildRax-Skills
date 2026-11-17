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
