import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { injectModel, viewerTemplatePath } from "@buildrax/viewer";
import { loadModel, loadNotes, loadResearch } from "./data.js";
import { collectSources } from "./sources.js";

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
  return injectModel(template, model, { notes, research, config, sources: sources?.files });
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
