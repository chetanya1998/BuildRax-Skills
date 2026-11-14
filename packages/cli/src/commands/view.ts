import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { validateModel } from "@buildrax/ir";
import { injectModel, viewerTemplatePath } from "@buildrax/viewer";
import { modelPathFor } from "./scan.js";

/** Build `.buildrax/view.html` from the existing model. The file works offline. */
export async function viewCommand(repoPath: string): Promise<string> {
  const root = path.resolve(repoPath);
  let raw: string;
  try {
    raw = await fs.readFile(modelPathFor(root), "utf8");
  } catch {
    throw new Error(
      `no model found at ${modelPathFor(root)}. Run \`buildrax scan ${repoPath}\` first.`,
    );
  }
  const checked = validateModel(JSON.parse(raw));
  if (!checked.ok || !checked.model)
    throw new Error(`model.json is invalid:\n${checked.errors.slice(0, 5).join("\n")}`);
  const template = await fs.readFile(viewerTemplatePath(), "utf8");
  const out = path.join(root, ".buildrax", "view.html");
  await fs.writeFile(out, injectModel(template, checked.model));
  return out;
}

/** Open a local file in the default browser. Arguments are passed without a shell. */
export function openFile(file: string): void {
  const [cmd, args]: [string, string[]] =
    process.platform === "darwin"
      ? ["open", [file]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", file]]
        : ["xdg-open", [file]];
  const child = spawn(cmd, args, { stdio: "ignore", detached: true });
  child.on("error", () =>
    console.error(`Could not open a browser automatically. Open ${file} manually.`),
  );
  child.unref();
}
