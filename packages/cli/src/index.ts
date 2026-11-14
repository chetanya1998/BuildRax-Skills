import { Command } from "commander";
import { formatSummary, scanCommand } from "./commands/scan.js";
import { openFile, viewCommand } from "./commands/view.js";

export { scanCommand, summarize, formatSummary, modelPathFor } from "./commands/scan.js";
export { viewCommand } from "./commands/view.js";

export function buildProgram(): Command {
  const program = new Command("buildrax")
    .description("Local, evidence-backed architecture map of your repository")
    .version("0.0.0");

  program
    .command("scan")
    .argument("[path]", "repository to scan", ".")
    .option("--json", "print the summary as JSON")
    .description("scan a repository statically and write .buildrax/model.json")
    .action(async (repo: string, opts: { json?: boolean }) => {
      const summary = await scanCommand(repo);
      console.log(opts.json ? JSON.stringify(summary, null, 2) : formatSummary(summary));
    });

  program
    .command("view")
    .argument("[path]", "repository containing .buildrax/model.json", ".")
    .option("--open", "open the viewer in the default browser")
    .description("generate .buildrax/view.html (single offline file)")
    .action(async (repo: string, opts: { open?: boolean }) => {
      const file = await viewCommand(repo);
      console.log(`Viewer written to ${file}`);
      if (opts.open) openFile(file);
    });

  return program;
}

export async function run(argv: string[]): Promise<void> {
  await buildProgram().parseAsync(argv);
}
