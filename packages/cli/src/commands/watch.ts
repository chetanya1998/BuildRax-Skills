import { watch, type FSWatcher } from "node:fs";
import path from "node:path";
import type { ModelDiff } from "@buildrax/graph";
import { isWatchedPath } from "@buildrax/ingest";
import { diffCommand } from "./diff.js";
import { scanCommand, type ScanSummary } from "./scan.js";

export interface RescanEvent {
  summary: ScanSummary;
  diff: ModelDiff;
  /** Repo-relative paths whose change triggered this rescan (first few). */
  changed: string[];
}

export interface Watcher {
  close(): void;
  /** Resolves when no scan is running or queued (for tests). */
  idle(): Promise<void>;
}

/**
 * Rescan incrementally whenever files change. Events are debounced, scans never overlap (changes
 * during a scan queue exactly one more), and folders the scanner ignores never trigger one.
 * Uses the OS's recursive file watching (Node ≥ 20 on Linux, macOS and Windows).
 */
export function watchRepo(
  repo: string,
  onRescan: (e: RescanEvent) => void,
  opts: { debounceMs?: number; onError?: (err: Error) => void } = {},
): Watcher {
  const root = path.resolve(repo);
  const debounceMs = opts.debounceMs ?? 400;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;
  let queued = false;
  let pending = new Set<string>();

  const runScan = async (): Promise<void> => {
    const changed = [...pending].sort().slice(0, 10);
    pending = new Set();
    try {
      const summary = await scanCommand(root);
      const { diff } = await diffCommand(root);
      onRescan({ summary, diff, changed });
    } catch (err) {
      opts.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  };
  const trigger = (): void => {
    if (running) {
      queued = true;
      return;
    }
    running = runScan().finally(() => {
      running = undefined;
      if (queued) {
        queued = false;
        trigger();
      }
    });
  };

  const w: FSWatcher = watch(root, { recursive: true }, (_event, file) => {
    if (!file) return;
    const rel = String(file).split(path.sep).join("/");
    if (!isWatchedPath(rel)) return;
    pending.add(rel);
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      trigger();
    }, debounceMs);
  });
  w.on("error", (err) => opts.onError?.(err));

  return {
    close: () => {
      clearTimeout(timer);
      timer = undefined;
      w.close();
    },
    idle: async () => {
      while (timer || running || queued) {
        if (running) await running;
        else await new Promise((r) => setTimeout(r, debounceMs + 20));
      }
    },
  };
}

/** One line for the terminal after each rescan. */
export function formatRescan(e: RescanEvent): string {
  const d = e.diff;
  const time = new Date().toLocaleTimeString();
  const parts = [
    d.nodes.added.length && `+${d.nodes.added.length} added`,
    d.nodes.removed.length && `-${d.nodes.removed.length} removed`,
    d.nodes.changed.length && `~${d.nodes.changed.length} changed`,
    (d.edges.added.length || d.edges.removed.length) &&
      `links +${d.edges.added.length}/-${d.edges.removed.length}`,
    d.cycles.introduced.length && `⚠ ${d.cycles.introduced.length} new cycle(s)`,
    d.cycles.resolved.length && `${d.cycles.resolved.length} cycle(s) resolved`,
  ].filter(Boolean);
  const what = e.changed.length
    ? `${e.changed.slice(0, 3).join(", ")}${e.changed.length > 3 ? ` +${e.changed.length - 3}` : ""}`
    : "files";
  const work = e.summary.work ? ` (parsed ${e.summary.work.parsed}, ${e.summary.work.ms} ms)` : "";
  return `[${time}] ${what} changed → ${parts.length ? parts.join(", ") : "no architecture change"}${work}`;
}
