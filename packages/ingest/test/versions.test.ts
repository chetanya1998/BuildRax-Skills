import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { minimumVersion, readLockedVersions, readRuntimes, scan } from "../src/index.js";

let tmp: string;
const FILES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "app", engines: { node: ">=20.11" } }),
  ".python-version": "3.12.4\n",
  "src/index.ts":
    'import express from "express";\nimport { z } from "zod";\nimport _ from "lodash";\n',
  "package-lock.json": JSON.stringify({
    lockfileVersion: 3,
    packages: {
      "": { name: "app" },
      "node_modules/express": { version: "4.21.2" },
      "node_modules/@scope/pkg": { version: "1.0.0" },
      "node_modules/express/node_modules/debug": { version: "2.6.9" },
    },
  }),
  "web/pnpm-lock.yaml": [
    "lockfileVersion: '9.0'",
    "importers:",
    "  .:",
    "    dependencies:",
    "      zod:",
    "        specifier: ^4.0.0",
    "        version: 4.6.7",
    "      '@types/node':",
    "        specifier: ^22",
    "        version: 22.10.0(typescript@5.9.3)",
    "      local:",
    "        specifier: workspace:*",
    "        version: link:../local",
    "",
  ].join("\n"),
  "legacy/yarn.lock": [
    '"lodash@^4.17.0":',
    '  version "4.17.21"',
    "",
    "react@18.2.0, react@^18:",
    '  version "18.2.0"',
    "",
  ].join("\n"),
  "worker/poetry.lock": [
    "[[package]]",
    'name = "Django"',
    'version = "5.2.1"',
    "",
    "[[package]]",
    'name = "requests"',
    'version = "2.32.3"',
    "",
  ].join("\n"),
  "worker/requirements.txt":
    "PyYAML==6.0.2\nflask>=3.0\n# comment\nuvicorn[standard]==0.30.1 ; python_version>'3.8'\n",
  "worker/app.py": "import requests\nimport yaml\nimport django\n",
};

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "buildrax-versions-"));
  for (const [f, text] of Object.entries(FILES)) {
    await fs.mkdir(path.dirname(path.join(tmp, f)), { recursive: true });
    await fs.writeFile(path.join(tmp, f), text);
  }
});
afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("pinned versions from lockfiles", () => {
  it("reads npm, pnpm, yarn, poetry and requirements lockfiles (direct installs only)", async () => {
    const v = await readLockedVersions(tmp, Object.keys(FILES));
    const one = (k: string) => v.get(k)?.map((l) => l.version);
    expect(one("npm:express")).toEqual(["4.21.2"]);
    expect(one("npm:@scope/pkg")).toEqual(["1.0.0"]);
    expect(v.has("npm:debug")).toBe(false); // nested copy, not a direct install
    expect(one("npm:zod")).toEqual(["4.6.7"]);
    expect(one("npm:@types/node")).toEqual(["22.10.0"]); // peer suffix stripped
    expect(v.has("npm:local")).toBe(false); // workspace link
    expect(one("npm:lodash")).toEqual(["4.17.21"]);
    expect(one("npm:react")).toEqual(["18.2.0"]);
    expect(one("pypi:django")).toEqual(["5.2.1"]);
    expect(one("pypi:pyyaml")).toEqual(["6.0.2"]);
    expect(one("pypi:uvicorn")).toEqual(["0.30.1"]);
    expect(v.has("pypi:flask")).toBe(false); // a range is not a pin
    expect(v.get("npm:zod")?.[0]).toMatchObject({ file: "web/pnpm-lock.yaml", line: 5 });
  });

  it("declared runtimes and their minimum versions", async () => {
    expect(await readRuntimes(tmp, Object.keys(FILES))).toEqual([
      {
        product: "python",
        declared: "3.12.4",
        version: "3.12.4",
        file: ".python-version",
        line: 1,
      },
      { product: "nodejs", declared: ">=20.11", version: "20.11", file: "package.json", line: 1 },
    ]);
    expect(minimumVersion("^3.10")).toBe("3.10");
    expect(minimumVersion(">=3.9,<4")).toBe("3.9");
    expect(minimumVersion("<4")).toBeUndefined();
    expect(minimumVersion("v22.1.0")).toBe("22.1.0");
    expect(minimumVersion("lts/iron")).toBeUndefined();
  });

  it("attaches versions to external nodes with lockfile evidence", async () => {
    const m = await scan(tmp, { now: "2026-11-24T00:00:00.000Z" });
    const ext = (name: string) => m.nodes.find((n) => n.kind === "external" && n.name === name);
    expect(ext("express")?.meta).toMatchObject({ version: "4.21.2" });
    expect(ext("express")?.evidence.at(-1)).toMatchObject({
      kind: "config",
      file: "package-lock.json",
      detail: "locked 4.21.2",
    });
    expect(ext("yaml")?.meta?.["version"]).toBeUndefined(); // import name differs from PyYAML: not guessed
    expect(m.nodes.find((n) => n.kind === "project")?.meta?.["runtimes"]).toHaveLength(2);
  });
});
