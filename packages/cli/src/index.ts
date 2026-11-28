import { decisionsCommand, formatDecisions, formatWhy, whyCommand } from "./commands/why.js";
import { formatFunctions, functionsCommand } from "./commands/functions.js";
import { Command } from "commander";
import { formatSummary, scanCommand } from "./commands/scan.js";
import { contextFor, renderDigest } from "@buildrax/context";
import { ALL_TARGETS, installSkill, type SkillScope, type SkillTarget } from "@buildrax/skills";
import path from "node:path";
import { loadModel, loadRationale } from "./commands/data.js";
import { formatNotes, notesCommand } from "./commands/notes.js";
import { formatTrace, traceCommand, type TraceDirection } from "./commands/trace.js";
import { formatPlan, formatResearch, researchCommand, researchPlan } from "./commands/research.js";
import { startServer } from "./commands/serve.js";
import { diffCommand, formatDiff, formatDiffMarkdown } from "./commands/diff.js";
import { formatRescan, watchRepo } from "./commands/watch.js";
import { flowCommand, formatFlows, formatRoutes, routesCommand } from "./commands/flows.js";
import { openFile, viewCommand } from "./commands/view.js";
import { createInterface } from "node:readline/promises";
import { credentialStatus } from "@buildrax/pricing";
import {
  askStack,
  costCommand,
  formatAssumptions,
  formatCost,
  formatPricingPlan,
  parseAssumptions,
  parsePairs,
  parseTiers,
  resolveStack,
} from "./commands/cost.js";

export {
  costCommand,
  formatCost,
  parseTiers,
  parseAssumptions,
  askStack,
  costPathFor,
} from "./commands/cost.js";

export { scanCommand, summarize, formatSummary } from "./commands/scan.js";
export {
  functionsPathFor,
  loadFunctions,
  loadRationale,
  rationalePathFor,
  modelPathFor,
  notesPathFor,
  researchPathFor,
} from "./commands/data.js";
export { findFunctions, formatFunctions, functionsCommand } from "./commands/functions.js";
export {
  decisionsCommand,
  formatDecisions,
  formatWhy,
  whyCommand,
  whyFor,
  PROVENANCE,
} from "./commands/why.js";
export { notesCommand, formatNotes } from "./commands/notes.js";
export { startServer } from "./commands/serve.js";
export { diffCommand, formatDiff, formatDiffMarkdown, scanAtRef } from "./commands/diff.js";
export { watchRepo, formatRescan } from "./commands/watch.js";
export { flowCommand, formatFlows, formatRoutes, routesCommand } from "./commands/flows.js";
export type { RescanEvent, Watcher } from "./commands/watch.js";
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
    .option("--no-cache", "re-parse every file (ignore the incremental parse cache)")
    .option("--watch", "keep running and rescan (incrementally) whenever files change")
    .option("--no-git", "do not read local git commit messages for rationale")
    .description("scan a repository statically and write .buildrax/model.json")
    .action(
      async (
        repo: string,
        opts: { json?: boolean; cache: boolean; watch?: boolean; git: boolean },
      ) => {
        const summary = await scanCommand(repo, { cache: opts.cache, git: opts.git });
        console.log(opts.json ? JSON.stringify(summary, null, 2) : formatSummary(summary));
        if (!opts.watch) return;
        console.log("Watching for changes (Ctrl+C to stop)…");
        watchRepo(repo, (e) => console.log(opts.json ? JSON.stringify(e.diff) : formatRescan(e)), {
          onError: (err) => console.error(`buildrax: rescan failed: ${err.message}`),
        });
        await new Promise(() => undefined); // until interrupted
      },
    );

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
        // Decision records only; a missing or stale index just leaves the list out.
        rationale: await loadRationale(repo).catch(() => undefined),
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

  const cost = program
    .command("cost")
    .description(
      "monthly cost estimate per traffic tier, from dated list prices (estimates, never quotes)",
    );
  cost
    .command("estimate", { isDefault: true })
    .argument("[path]", "repository (uses .buildrax/model.json when present)", ".")
    .option("--mode <mode>", "current (what the repo declares) | product (as a product)", "current")
    .option("--tiers <list>", "user tiers", "100,1k,10k,100k,1m")
    .option("--stack <answers>", "stack answers, e.g. database=postgres,cache=none,llm=openai")
    .option("--region <code>", "AWS region (same as --stack region=…)")
    .option("--assume <pairs>", "override assumptions, e.g. dauRatio=0.3,requestsPerDau=100")
    .option("--yes", "accept the pre-selected stack without asking")
    .option("--online", "download AWS list prices (default: only cached prices are used)")
    .option(
      "--use-credentials",
      "with --online: query the AWS Price List API with credentials from the environment",
    )
    .option("--list-assumptions", "print every assumption with its default and exit")
    .option("--json", "print the report as JSON")
    .action(
      async (
        repo: string,
        opts: {
          mode: string;
          tiers: string;
          stack?: string;
          region?: string;
          assume?: string;
          yes?: boolean;
          online?: boolean;
          useCredentials?: boolean;
          listAssumptions?: boolean;
          json?: boolean;
        },
      ) => {
        if (opts.listAssumptions) {
          console.log(formatAssumptions());
          return;
        }
        if (opts.mode !== "current" && opts.mode !== "product")
          throw new Error("--mode must be current or product");
        const answers = parsePairs(opts.stack);
        if (opts.region) answers["region"] = opts.region;
        // Product mode asks the short stack questionnaire (Enter keeps each default).
        if (opts.mode === "product" && !opts.yes && !opts.json && process.stdin.isTTY) {
          const { stack } = await resolveStack(repo, answers);
          const rl = createInterface({ input: process.stdin, output: process.stdout });
          console.log("Stack for the estimate (Enter keeps the [default]):");
          try {
            Object.assign(answers, await askStack(stack, (q) => rl.question(q)));
          } finally {
            rl.close();
          }
        }
        const r = await costCommand(repo, {
          mode: opts.mode,
          tiers: parseTiers(opts.tiers),
          stack: answers,
          assumptions: parseAssumptions(opts.assume),
          online: opts.online,
          useCredentials: opts.useCredentials,
          onProgress: opts.json ? undefined : (m) => console.error(`  fetching ${m}`),
        });
        for (const w of r.warnings) console.error(`warning: ${w}`);
        if (opts.json) {
          console.log(JSON.stringify(r.report, null, 2));
          return;
        }
        if (r.plan) console.log(`${formatPricingPlan(r.plan)}\n`);
        console.log(formatCost(r.report));
        console.log(`\nWritten to ${r.file}`);
      },
    );
  cost
    .command("credentials")
    .argument("<action>", "status | clear")
    .description("optional AWS credentials: where they are read from (values are never shown)")
    .action((action: string) => {
      if (action !== "status" && action !== "clear")
        throw new Error("use: buildrax cost credentials status|clear");
      const s = credentialStatus();
      if (action === "status") console.log(`AWS: ${s.aws}\n${s.stored}`);
      else
        console.log(
          `${s.stored}. To stop using environment credentials, unset AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN in your shell.`,
        );
    });

  program
    .command("diff")
    .argument("[path]", "repository containing .buildrax/model.json", ".")
    .option("--since <ref>", "compare with the repository at a git ref (e.g. main, HEAD~5)")
    .option("--against <model>", "compare with a saved model.json")
    .option("--json", "print as JSON")
    .option("--markdown", "print Markdown (for CI job summaries and PR comments)")
    .option("--fail-on-new-cycles", "exit with code 1 when a circular dependency is introduced")
    .description(
      "architecture changes: nodes, links and circular dependencies added or removed (default: since the previous scan)",
    )
    .action(
      async (
        repo: string,
        opts: {
          since?: string;
          against?: string;
          json?: boolean;
          markdown?: boolean;
          failOnNewCycles?: boolean;
        },
      ) => {
        const { diff, baseline } = await diffCommand(repo, opts);
        console.log(
          opts.json
            ? JSON.stringify(diff, null, 2)
            : opts.markdown
              ? formatDiffMarkdown(diff, baseline)
              : formatDiff(diff, baseline),
        );
        if (opts.failOnNewCycles && diff.cycles.introduced.length) {
          console.error(
            `buildrax: ${diff.cycles.introduced.length} circular dependency(ies) introduced`,
          );
          process.exitCode = 1;
        }
      },
    );

  program
    .command("routes")
    .argument("[path]", "repository containing .buildrax/model.json", ".")
    .option("--reaching <component>", "only endpoints whose flow reaches it (e.g. a database)")
    .option("--json", "print as JSON")
    .description("list the endpoints the scan found (API routes and pages)")
    .action(async (repo: string, opts: { json?: boolean; reaching?: string }) => {
      const routes = await routesCommand(repo, { reaching: opts.reaching });
      console.log(opts.json ? JSON.stringify(routes, null, 2) : formatRoutes(routes));
    });

  program
    .command("flow")
    .argument("<endpoint>", '"METHOD /path", a path (all methods) or a route id')
    .argument("[path]", "repository containing .buildrax/model.json", ".")
    .option("--depth <n>", "how many hops to follow from the handler's file", "6")
    .option("--json", "print as JSON")
    .description("follow an endpoint to the code, services, queues and databases it can reach")
    .action(async (endpoint: string, repo: string, opts: { depth: string; json?: boolean }) => {
      const { flows } = await flowCommand(repo, endpoint, { depth: Number(opts.depth) });
      console.log(
        opts.json ? JSON.stringify(flows, null, 2) : await formatFlows(repo, flows, endpoint),
      );
    });

  program
    .command("why")
    .argument("<target>", "node id, file path, folder, package, service or route")
    .argument("[path]", "repository containing .buildrax/rationale.json", ".")
    .option("--json", "print as JSON")
    .description(
      "why it is built this way: decision records, docs, explaining comments and commit messages",
    )
    .action(async (target: string, repo: string, opts: { json?: boolean }) => {
      const res = await whyCommand(repo, target);
      console.log(opts.json ? JSON.stringify(res, null, 2) : formatWhy(res));
    });

  program
    .command("decisions")
    .argument("[path]", "repository containing .buildrax/rationale.json", ".")
    .option("--json", "print as JSON")
    .description("list architecture decision records (ADRs) with status and date")
    .action(async (repo: string, opts: { json?: boolean }) => {
      const adrs = await decisionsCommand(repo);
      console.log(opts.json ? JSON.stringify(adrs, null, 2) : formatDecisions(adrs));
    });

  program
    .command("fn")
    .argument("<query>", "a file path (lists its functions), a function name or Class.method")
    .argument("[path]", "repository containing .buildrax/functions.json", ".")
    .option("--json", "print as JSON")
    .description("drill into functions: calls, callers, data operations and routes they handle")
    .action(async (query: string, repo: string, opts: { json?: boolean }) => {
      const res = await functionsCommand(repo, query);
      console.log(opts.json ? JSON.stringify(res, null, 2) : formatFunctions(res, query));
    });

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
    .option("--watch", "rescan when files change; open viewers offer a refresh")
    .description("serve the viewer locally; notes are saved to .buildrax/notes.json")
    .action(async (repo: string, opts: { port: string; open?: boolean; watch?: boolean }) => {
      if (opts.watch) console.log(formatSummary(await scanCommand(repo)));
      const server = await startServer(repo, Number(opts.port), {
        watch: opts.watch,
        onRescan: (e) => console.log(formatRescan(e)),
        onError: (err) => console.error(`buildrax: rescan failed: ${err.message}`),
      });
      console.log(
        `BuildRAX viewer: ${server.url}${opts.watch ? "  (watching for changes)" : ""}  (Ctrl+C to stop)`,
      );
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
