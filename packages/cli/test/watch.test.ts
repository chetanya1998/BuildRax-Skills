import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  formatRescan,
  scanCommand,
  startServer,
  watchRepo,
  type RescanEvent,
} from "../src/index.js";

const FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../fixtures/sample-monorepo",
);
let tmp: string;

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "buildrax-watch-"));
  await fs.cp(FIXTURE, tmp, { recursive: true });
  await scanCommand(tmp);
});
afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

async function until<T>(get: () => T | undefined | Promise<T | undefined>, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await get();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("watch", () => {
  it("rescans after a change and reports what changed; ignored folders never trigger", async () => {
    const events: RescanEvent[] = [];
    const w = watchRepo(tmp, (e) => events.push(e), { debounceMs: 100 });
    try {
      await new Promise((r) => setTimeout(r, 200));
      await fs.mkdir(path.join(tmp, "node_modules/x"), { recursive: true });
      await fs.writeFile(path.join(tmp, "node_modules/x/index.js"), "export {}\n");
      await new Promise((r) => setTimeout(r, 400));
      expect(events).toHaveLength(0);

      await fs.writeFile(
        path.join(tmp, "packages/shared/src/watched.ts"),
        'import "./index.js";\n',
      );
      const e = await until(() => events[0]);
      expect(e.diff.nodes.added.map((n) => n.id)).toContain("file:packages/shared/src/watched.ts");
      expect(e.summary.work?.parsed).toBe(1);
      expect(e.changed.some((c) => c.endsWith("watched.ts"))).toBe(true);
      expect(formatRescan(e)).toMatch(/watched\.ts changed → \+1 added/);
    } finally {
      w.close();
    }
  });

  it("serve --watch bumps the version the viewer polls (token required)", async () => {
    const server = await startServer(tmp, 0, { watch: true });
    const port = new URL(server.url).port;
    const get = (token?: string) =>
      fetch(`http://127.0.0.1:${port}/api/version`, {
        headers: token ? { "x-buildrax-token": token } : {},
      });
    try {
      expect((await get()).status).toBe(401);
      expect(await (await get(server.token)).json()).toMatchObject({ version: 0 });
      const html = await (await fetch(server.url)).text();
      expect(html).toContain('"watch":true');
      await new Promise((r) => setTimeout(r, 200));
      await fs.writeFile(path.join(tmp, "packages/shared/src/live.ts"), 'import "./index.js";\n');
      const v = await until(async () => {
        const j = (await (await get(server.token)).json()) as { version: number; added: number };
        return j.version > 0 ? j : undefined;
      });
      expect(v.added).toBe(1);
    } finally {
      await server.close();
    }
  });
});
