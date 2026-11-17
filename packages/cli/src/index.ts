import { Command } from "commander";
import { formatSummary, scanCommand } from "./commands/scan.js";
import { contextFor, renderDigest } from "@buildrax/context";
import { ALL_TARGETS, installSkill, type SkillScope, type SkillTarget } from "@buildrax/skills";
import path from "node:path";
import { loadModel } from "./commands/data.js";
import { formatNotes, notesCommand } from "./commands/notes.js";
import { formatTrace, traceCommand, type TraceDirection } from "./commands/trace.js";
import { formatPlan, formatResearch, researchCommand, researchPlan } from "./commands/research.js";
import { startServer } from "./commands/serve.js";
import { openFile, viewCommand } from "./commands/view.js";

export { scanCommand, summarize, formatSummary } from "./commands/scan.js";
export { modelPathFor, notesPathFor, researchPathFor } from "./commands/data.js";
export { notesCommand, formatNotes } from "./commands/notes.js";
export { startServer } from "./commands/serve.js";
export { traceModel, traceCommand, formatTrace, resolveTarget } from "./commands/trace.js";
export { formatPlan, researchCommand, researchPlan } from "./commands/research.js";
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
    .option("--no-source", "do not embed source code (the Code tab will be empty)")
    .description(
      "generate .buildrax/view.html (single offline file, includes source for the Code tab)",
    )
    .action(async (repo: string, opts: { open?: boolean; source: boolean }) => {
      const file = await viewCommand(repo, { source: opts.source });
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
    .command("research")
    .argument("[path]", "repository containing .buildrax/model.json", ".")
    .option("--online", "actually contact the public registries (default: only show the plan)")
    .option("--limit <n>", "research at most n dependencies", "50")
    .option("--no-cache", "ignore the local 24h response cache")
    .option("--json", "print as JSON")
    .description(
      "look up current registry facts for your dependencies (opt-in; sends package names only)",
    )
    .action(
      async (
        repo: string,
        opts: { online?: boolean; limit: string; cache: boolean; json?: boolean },
      ) => {
        const limit = Number(opts.limit);
        if (!opts.online) {
          const plan = await researchPlan(repo, { limit });
          console.log(opts.json ? JSON.stringify(plan, null, 2) : formatPlan(plan));
          return;
        }
        const file = await researchCommand(repo, { limit, cache: opts.cache });
        console.log(opts.json ? JSON.stringify(file, null, 2) : formatResearch(file));
      },
    );

  program
    .command("trace")
    .argument("<target>", "node id, file path, module path or name")
    .argument("[path]", "repository containing .buildrax/model.json", ".")
    .option(
      "--direction <dir>",
      "up = what depends on it (impact), down = what it depends on",
      "up",
    )
    .option("--depth <n>", "max hops (default: unlimited)")
    .option("--json", "print as JSON")
    .description("transitive dependency trace with file:line evidence (no LLM)")
    .action(
      async (
        target: string,
        repo: string,
        opts: { direction: string; depth?: string; json?: boolean },
      ) => {
        if (opts.direction !== "up" && opts.direction !== "down")
          throw new Error("--direction must be up or down");
        const r = await traceCommand(repo, target, {
          direction: opts.direction as TraceDirection,
          depth: opts.depth ? Number(opts.depth) : undefined,
        });
        console.log(opts.json ? JSON.stringify(r, null, 2) : formatTrace(r));
      },
    );

  program
    .command("install-skill")
    .option("--target <t>", "claude | codex | antigravity | all", "all")
    .option("--scope <s>", "project (this repo) or user (your home directory)", "project")
    .option("--dir <path>", "install into <path>/buildrax instead of the default location")
    .option("--force", "replace an existing skill directory that BuildRAX did not create")
    .option("--dry-run", "show where the skill would be installed")
    .description("install the BuildRAX agent skill for Claude Code, Codex and/or Antigravity")
    .action(
      async (opts: {
        target: string;
        scope: string;
        dir?: string;
        force?: boolean;
        dryRun?: boolean;
      }) => {
        if (opts.scope !== "project" && opts.scope !== "user")
          throw new Error("--scope must be project or user");
        if (opts.target !== "all" && !ALL_TARGETS.includes(opts.target as SkillTarget)) {
          throw new Error(`--target must be one of: ${ALL_TARGETS.join(", ")}, all`);
        }
        const results = await installSkill({
          targets: opts.target === "all" ? ALL_TARGETS : [opts.target as SkillTarget],
          scope: opts.scope as SkillScope,
          projectRoot: process.cwd(),
          dir: opts.dir,
          force: opts.force,
          dryRun: opts.dryRun,
        });
        for (const r of results) {
          console.log(
            `${r.status.padEnd(9)} ${r.plan.dir}  (${r.plan.targets.join(" + ")})${r.reason ? ` - ${r.reason}` : ""}`,
          );
        }
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
