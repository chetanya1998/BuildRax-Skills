import { Command } from "commander";
import { formatSummary, scanCommand } from "./commands/scan.js";
import { contextFor, renderDigest } from "@buildrax/context";
import path from "node:path";
import { loadModel } from "./commands/data.js";
import { formatNotes, notesCommand } from "./commands/notes.js";
import { startServer } from "./commands/serve.js";
import { openFile, viewCommand } from "./commands/view.js";

export { scanCommand, summarize, formatSummary } from "./commands/scan.js";
export { modelPathFor, notesPathFor, researchPathFor } from "./commands/data.js";
export { notesCommand, formatNotes } from "./commands/notes.js";
export { startServer } from "./commands/serve.js";
export type { RunningServer } from "./commands/serve.js";
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

  program
    .command("digest")
    .argument("[path]", "repository containing .buildrax/model.json", ".")
    .option("--level <n>", "0 = packages, 1 = packages + directories", "0")
    .option("--budget <tokens>", "approximate token budget")
    .option("--json", "print as JSON")
    .description("compact overview of the architecture for agents (no LLM, notes excluded)")
    .action(async (repo: string, opts: { level: string; budget?: string; json?: boolean }) => {
      const d = renderDigest(await loadModel(repo), {
        level: opts.level === "1" ? 1 : 0,
        budgetTokens: opts.budget ? Number(opts.budget) : undefined,
      });
      console.log(opts.json ? JSON.stringify(d, null, 2) : d.text);
    });

  program
    .command("context")
    .argument("<question>", "what you want to know, in plain words")
    .argument("[path]", "repository containing .buildrax/model.json", ".")
    .option("--budget <tokens>", "approximate token budget", "4000")
    .option("--snippets", "include short code snippets around the evidence")
    .option("--json", "print as JSON")
    .description("bounded, evidence-linked context for a question (no LLM, notes excluded)")
    .action(
      async (
        question: string,
        repo: string,
        opts: { budget: string; snippets?: boolean; json?: boolean },
      ) => {
        const pack = await contextFor(await loadModel(repo), question, {
          budgetTokens: Number(opts.budget),
          root: opts.snippets ? path.resolve(repo) : undefined,
        });
        console.log(opts.json ? JSON.stringify(pack, null, 2) : pack.text);
      },
    );

  program
    .command("serve")
    .argument("[path]", "repository containing .buildrax/model.json", ".")
    .option("--port <n>", "port to listen on (127.0.0.1 only)", "4317")
    .option("--open", "open the viewer in the default browser")
    .description("serve the viewer locally; notes are saved to .buildrax/notes.json")
    .action(async (repo: string, opts: { port: string; open?: boolean }) => {
      const server = await startServer(repo, Number(opts.port));
      console.log(`BuildRAX viewer: ${server.url}  (Ctrl+C to stop)`);
      if (opts.open) openFile(server.url);
    });

  program
    .command("notes")
    .argument("[path]", "repository", ".")
    .option("--all", "include resolved notes")
    .option("--json", "print as JSON")
    .description("list your sticky notes and flags (read-only)")
    .action(async (repo: string, opts: { all?: boolean; json?: boolean }) => {
      const report = await notesCommand(repo, opts);
      console.log(opts.json ? JSON.stringify(report, null, 2) : formatNotes(report));
    });

  return program;
}

export async function run(argv: string[]): Promise<void> {
  await buildProgram().parseAsync(argv);
}
