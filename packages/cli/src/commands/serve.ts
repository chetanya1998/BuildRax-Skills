import { randomBytes, timingSafeEqual } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { validateNotes } from "@buildrax/ir";
import { loadModel, loadNotes, saveNotes } from "./data.js";
import { readModelFile } from "./sources.js";
import { readExcerpt } from "./excerpts.js";
import { buildViewerHtml } from "./view.js";
import { watchRepo, type RescanEvent } from "./watch.js";

export interface RunningServer {
  url: string;
  token: string;
  close(): Promise<void>;
  /** With watch: resolves when no rescan is running or queued. */
  idle(): Promise<void>;
}

export interface ServeOptions {
  /** Rescan on file changes and tell open viewers (they offer a refresh). */
  watch?: boolean;
  onRescan?: (e: RescanEvent) => void;
  onError?: (err: Error) => void;
}

/** What the viewer polls: a counter that grows with every rescan, plus what changed. */
interface VersionInfo {
  version: number;
  at?: string;
  added: number;
  removed: number;
  changed: number;
  links: number;
  cycles: number;
}

const MAX_BODY = 2_000_000;

function tokenOk(given: string | undefined, expected: string): boolean {
  if (!given || given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * Local-only server for the viewer and the notes API. It binds to 127.0.0.1, serves no files from
 * disk (so there is no path-traversal surface), and requires a per-run token plus matching Host
 * and Origin headers for API calls, which blocks DNS-rebinding and cross-site writes.
 */
export async function startServer(
  repo: string,
  port = 4317,
  opts: ServeOptions = {},
): Promise<RunningServer> {
  const token = randomBytes(16).toString("hex");
  let info: VersionInfo = { version: 0, added: 0, removed: 0, changed: 0, links: 0, cycles: 0 };
  let allowedHosts = new Set<string>();

  const send = (
    res: http.ServerResponse,
    status: number,
    body: string,
    type = "application/json",
  ): void => {
    res.writeHead(status, {
      "content-type": `${type}; charset=utf-8`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    res.end(body);
  };

  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        const host = req.headers.host ?? "";
        if (!allowedHosts.has(host)) return send(res, 403, JSON.stringify({ error: "bad host" }));
        const url = new URL(req.url ?? "/", `http://${host}`);

        if (req.method === "GET" && url.pathname === "/") {
          return send(
            res,
            200,
            await buildViewerHtml(repo, {
              server: true,
              token,
              version: info.version,
              watch: !!opts.watch,
            }),
            "text/html",
          );
        }
        if (!url.pathname.startsWith("/api/"))
          return send(res, 404, JSON.stringify({ error: "not found" }));

        const origin = req.headers.origin;
        if (origin && origin !== `http://${host}`)
          return send(res, 403, JSON.stringify({ error: "bad origin" }));
        if (!tokenOk(req.headers["x-buildrax-token"] as string | undefined, token)) {
          return send(res, 401, JSON.stringify({ error: "missing or invalid token" }));
        }

        if (url.pathname === "/api/version" && req.method === "GET")
          return send(res, 200, JSON.stringify(info));
        if (url.pathname === "/api/model" && req.method === "GET")
          return send(res, 200, JSON.stringify(await loadModel(repo)));
        if (url.pathname === "/api/file" && req.method === "GET") {
          const rel = url.searchParams.get("path") ?? "";
          const text = await readModelFile(repo, await loadModel(repo), rel);
          if (text === undefined)
            return send(res, 404, JSON.stringify({ error: "not a scanned source file" }));
          return send(res, 200, JSON.stringify({ path: rel, text }));
        }
        if (url.pathname === "/api/excerpt" && req.method === "GET") {
          // Only lines around recorded evidence in config files, redacted.
          const file = url.searchParams.get("file") ?? "";
          const line = Number(url.searchParams.get("line"));
          const ex = Number.isInteger(line)
            ? await readExcerpt(repo, await loadModel(repo), file, line)
            : undefined;
          if (!ex)
            return send(res, 404, JSON.stringify({ error: "not a recorded config evidence line" }));
          return send(res, 200, JSON.stringify(ex));
        }
        if (url.pathname === "/api/notes" && req.method === "GET")
          return send(res, 200, JSON.stringify(await loadNotes(repo)));
        if (url.pathname === "/api/notes" && req.method === "PUT") {
          if (!(req.headers["content-type"] ?? "").startsWith("application/json")) {
            return send(
              res,
              415,
              JSON.stringify({ error: "content-type must be application/json" }),
            );
          }
          const checked = validateNotes(JSON.parse(await readBody(req)));
          if (!checked.ok || !checked.file)
            return send(res, 400, JSON.stringify({ error: checked.errors.slice(0, 5) }));
          await saveNotes(repo, checked.file);
          return send(res, 200, JSON.stringify({ ok: true, count: checked.file.notes.length }));
        }
        return send(res, 404, JSON.stringify({ error: "not found" }));
      } catch (err) {
        send(res, 500, JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const actual = (server.address() as AddressInfo).port;
  allowedHosts = new Set([`127.0.0.1:${actual}`, `localhost:${actual}`]);

  const watcher = opts.watch
    ? watchRepo(
        repo,
        (e) => {
          const d = e.diff;
          if (!d.same || d.cycles.introduced.length || d.cycles.resolved.length)
            info = {
              version: info.version + 1,
              at: new Date().toISOString(),
              added: d.nodes.added.length,
              removed: d.nodes.removed.length,
              changed: d.nodes.changed.length,
              links: d.edges.added.length + d.edges.removed.length,
              cycles: d.cycles.introduced.length,
            };
          opts.onRescan?.(e);
        },
        { onError: opts.onError },
      )
    : undefined;

  return {
    url: `http://127.0.0.1:${actual}/`,
    token,
    close: () =>
      new Promise((resolve) => {
        watcher?.close();
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
    idle: async () => watcher?.idle(),
  };
}
