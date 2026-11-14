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
