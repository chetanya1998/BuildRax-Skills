import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadModel } from "../src/commands/data.js";
import {
  MASK,
  collectExcerpts,
  configAnchors,
  excerptOf,
  readExcerpt,
  redactLine,
} from "../src/commands/excerpts.js";
import { scanCommand, startServer, viewCommand } from "../src/index.js";

const FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../fixtures/infra-app",
);
let tmp: string;
beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "buildrax-excerpts-"));
  await fs.cp(FIXTURE, tmp, { recursive: true });
  await scanCommand(tmp);
});
afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("secret masking", () => {
  it.each([
    ["      POSTGRES_PASSWORD: hunter2", `      POSTGRES_PASSWORD: ${MASK}`],
    ['  password          = "hunter2"', `  password          = "${MASK}"`],
    ["      - API_TOKEN=abc123", `      - API_TOKEN=${MASK}`],
    ["SECRET_KEY='x y z'", `SECRET_KEY='${MASK}'`],
    ['  "stripeSecret": "whatever",', `  "stripeSecret": "${MASK}",`],
    ["      AWS_ACCESS_KEY_ID: AKIAABCDEFGHIJKLMNOP", `      AWS_ACCESS_KEY_ID: ${MASK}`],
    ["      DATABASE_URL: postgres://app:pa55@db:5432/app", `      DATABASE_URL: ${MASK}`],
  ])("masks the value of %j", (line, want) => {
    expect(redactLine(line)).toBe(want);
  });

  it("masks credentials inside URLs and known token shapes anywhere", () => {
    expect(redactLine("  url: redis://default:pa55word@cache:6379")).toBe(
      `  url: redis://default:${MASK}@cache:6379`,
    );
    expect(redactLine("command: run --key sk-live_ABCDEFGHIJKLMNOPQRST")).not.toContain(
      "ABCDEFGHIJKLMNOP",
    );
    expect(redactLine("# ghp_abcdefghijklmnopqrstuvwxyz0123456789")).toBe(`# ${MASK}`);
    expect(redactLine("token eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2Q")).not.toContain(
      "eyJ",
    );
  });

  it("keeps references and ordinary settings readable", () => {
    expect(redactLine("  password       = var.db_password")).toBe(
      "  password       = var.db_password",
    );
    expect(redactLine("      PASSWORD: ${DB_PASSWORD}")).toBe("      PASSWORD: ${DB_PASSWORD}");
    expect(redactLine("    image: postgres:16-alpine")).toBe("    image: postgres:16-alpine");
    expect(redactLine('  instance_class    = "db.t4g.small"')).toBe(
      '  instance_class    = "db.t4g.small"',
    );
    expect(redactLine("      replicas: 2")).toBe("      replicas: 2");
  });

  it("excerpts are ±3 lines, redacted, with their real start line", () => {
    const text = [
      "a: 1",
      "b: 2",
      "c: 3",
      "password: x",
      "d: 4",
      "e: 5",
      "f: 6",
      "g: 7",
      "h: 8",
    ].join("\n");
    expect(excerptOf(text, 4)).toEqual({
      start: 1,
      lines: ["a: 1", "b: 2", "c: 3", `password: ${MASK}`, "d: 4", "e: 5", "f: 6"],
    });
    expect(excerptOf(text, 99)).toBeUndefined();
  });
});

describe("config excerpts in the viewer", () => {
  it("come only from recorded evidence lines in non-source files, never real .env files", async () => {
    const model = await loadModel(tmp);
    const anchors = configAnchors(model);
    expect(anchors.get("docker-compose.yml")?.has(19)).toBe(true);
    expect([...anchors.keys()].some((f) => f.endsWith(".ts"))).toBe(false);
    expect(anchors.has(".env")).toBe(false);
  });

  it("are embedded redacted: no secret from the fixture reaches view.html", async () => {
    const all = await collectExcerpts(tmp, await loadModel(tmp));
    const db = all["docker-compose.yml:19"]!;
    expect(db.start).toBe(16);
    expect(db.lines).toContain("    image: postgres:16-alpine");
    const html = await fs.readFile(await viewCommand(tmp), "utf8");
    for (const secret of [
      "not-a-real-password-789",
      "not-a-real-pass",
      "not-a-real-tf-password",
      "not-a-real-secret",
    ])
      expect(html).not.toContain(secret);
    expect(html).toContain('"docker-compose.yml:19"');
    const bare = await fs.readFile(await viewCommand(tmp, { source: false }), "utf8");
    expect(bare).not.toContain('"docker-compose.yml:19"');
  });

  it("serve answers only for recorded evidence lines, with the token", async () => {
    const model = await loadModel(tmp);
    const recorded = configAnchors(model).get("docker-compose.yml")!;
    const notEvidence = [...Array(30).keys()].map((i) => i + 1).find((l) => !recorded.has(l))!;
    expect(await readExcerpt(tmp, model, "docker-compose.yml", notEvidence)).toBeUndefined();
    expect(await readExcerpt(tmp, model, "../../etc/passwd", 1)).toBeUndefined();
    const server = await startServer(tmp, 0);
    const port = new URL(server.url).port;
    const get = (q: string, token?: string) =>
      fetch(`http://127.0.0.1:${port}/api/excerpt?${q}`, {
        headers: token ? { "x-buildrax-token": token } : {},
      });
    try {
      expect((await get("file=docker-compose.yml&line=19")).status).toBe(401);
      const ok = (await (await get("file=docker-compose.yml&line=19", server.token)).json()) as {
        lines: string[];
      };
      expect(ok.lines.join("\n")).not.toContain("not-a-real-password-789");
      expect((await get(`file=docker-compose.yml&line=${notEvidence}`, server.token)).status).toBe(
        404,
      );
      expect((await get("file=.env&line=1", server.token)).status).toBe(404);
    } finally {
      await server.close();
    }
  });
});
