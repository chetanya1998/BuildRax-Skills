import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { injectModel, viewerTemplatePath } from "@buildrax/viewer";
import { loadModel, loadNotes, loadResearch } from "./data.js";
import { collectSources } from "./sources.js";
import { costPathFor, costPricesPathFor } from "./cost.js";

/** The last `buildrax cost` report and its prices, when both exist and parse. */
async function loadCostForViewer(
  repo: string,
): Promise<{ report: unknown; prices: unknown } | undefined> {
  try {
    const [report, prices] = await Promise.all([
      fs.readFile(costPathFor(repo), "utf8"),
      fs.readFile(costPricesPathFor(repo), "utf8"),
    ]);
    return { report: JSON.parse(report), prices: JSON.parse(prices) };
  } catch {
    return undefined;
  }
}

/**
 * Build the viewer HTML for a repo (shared by `view` and `serve`). Static files embed the scanned
 * source so the Code tab works offline; served pages load files on demand instead.
 */
export async function buildViewerHtml(
  repoPath: string,
  config?: { server: true; token: string },
  opts: { embedSource?: boolean } = {},
): Promise<string> {
  const model = await loadModel(repoPath);
  const [notes, research, template, sources] = await Promise.all([
    loadNotes(repoPath),
    loadResearch(repoPath),
    fs.readFile(viewerTemplatePath(), "utf8"),
    !config && opts.embedSource !== false ? collectSources(repoPath, model) : undefined,
  ]);
  const cost = await loadCostForViewer(repoPath);
  return injectModel(template, model, {
    notes,
    research,
    config,
    sources: sources?.files,
    cost,
  });
}

/** Build `.buildrax/view.html` from the existing model. The file works offline. */
export async function viewCommand(
  repoPath: string,
  opts: { source?: boolean } = {},
): Promise<string> {
  const root = path.resolve(repoPath);
  const out = path.join(root, ".buildrax", "view.html");
  await fs.writeFile(out, await buildViewerHtml(root, undefined, { embedSource: opts.source }));
  return out;
}

/** Open a local file or URL in the default browser. Arguments are passed without a shell. */
export function openFile(target: string): void {
  const [cmd, args]: [string, string[]] =
    process.platform === "darwin"
      ? ["open", [target]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", target]]
        : ["xdg-open", [target]];
  const child = spawn(cmd, args, { stdio: "ignore", detached: true });
  child.on("error", () =>
    console.error(`Could not open a browser automatically. Open ${target} manually.`),
  );
  child.unref();
}
