---
name: buildrax
description: Map this repository's architecture with evidence, list its API endpoints and follow request flows, trace dependencies and change impact, find circular dependencies, and open an interactive architecture viewer. Use when asked about architecture, system design, how parts connect, what depends on X, what breaks if X changes, circular imports, what the project would cost to run or to scale as a product, or for an architecture diagram. The scan is local and static and uses no LLM tokens.
---

# BuildRAX

BuildRAX turns the repository into a typed architecture graph where every node and edge points at
`file:line` evidence. You call its CLI; you do not analyze the architecture yourself.

Run commands as `buildrax <command>` (use `npx buildrax <command>` if it is not on PATH).

## Workflow

1. **Scan** (local, static, zero LLM tokens): `buildrax scan`. Re-run when code changed since the
   last scan. It writes `.buildrax/model.json`; never edit that file by hand.
2. **Orient** with `buildrax digest` (a few hundred tokens). Do not read `model.json` or dump
   source files to understand the system.
3. **Answer a question** with `buildrax context "<the question in plain words>" --budget 3000`.
   Add `--snippets` when you need the lines of code. Cite the `file:line` anchors it returns.
4. **What changed** (a PR, a branch, since last time): `buildrax diff --since <ref>` lists added
   and removed components, links, circular dependencies and changed infrastructure.
   **Impact / dependencies** with `buildrax trace <file|module|id> [--direction up|down] [--depth N]`.
   `up` = what depends on it (what could break if it changes); `down` = what it depends on.
5. **APIs and request flows** ("what does POST /orders touch?", "which endpoints hit the orders
   database?"): `buildrax routes` lists endpoints with `file:line`; `buildrax flow "POST /orders"`
   follows one to the files, services, queues and databases it can reach, as numbered steps
   (which tables it reads or writes, what it publishes, and the worker that consumes it);
   `buildrax routes --reaching database:postgres` lists the endpoints that reach a component.
   Data models (Prisma, TypeORM, Drizzle, Mongoose, Django, SQLAlchemy) are `entity` nodes with
   `relates` edges; the digest lists them under DATA MODELS. Say that flows are static and file-level. The viewer's **Flows** view (`E`) shows the same as a
   diagram.
6. **Show the user** `buildrax view --open` (static file) or `buildrax serve --open` (live, lets
   them save their notes into the repo).
7. **Outside facts** (security advisories for pinned versions, end-of-life dates, latest versions,
   deprecations, docs): first run `buildrax research` (shows
   what would be sent, sends nothing). Only run `buildrax research --online` after the user agrees.
8. **Cost** ("what does this cost", "what if it became a product"): follow `references/cost.md`.
   In short: ask the user for the stack before `--mode product`, run `buildrax cost` (no network),
   and only add `--online` (AWS list prices) after the user agrees.

Add `--json` to `scan`, `digest`, `context`, `trace`, `routes`, `flow`, `notes`, `research`, `cost` when you need to parse output.
More detail: `references/commands.md`, `references/answering-questions.md`, `references/limits.md`,
`references/cost.md`.

## Rules

- **Never invent** nodes, edges, files or dependencies. If BuildRAX did not report it, say so.
- **Cite evidence.** Every claim about code needs a `file:line` from BuildRAX output or from a file
  you opened afterwards.
- **Say how sure it is.** Evidence is `verified` (from code), `config` (manifests), `inferred`
  (heuristic grouping) or `unresolved` (target not found). Report `unresolved` imports as such.
- **Static analysis cannot see** dynamic imports, dependency injection, runtime wiring, or load.
  No edge does not prove no dependency. Never claim runtime behaviour (latency, throughput).
- **Cost figures are estimates** and only come from `buildrax cost`. Always give the range, the
  assumptions and the missing prices. Never invent a price.
- **Notes belong to the user.** Read them with `buildrax notes` if asked. Do not create, edit or
  delete notes. `digest` and `context` leave them out on purpose; do not paste them elsewhere.
- **Research is read-only facts.** Advisories and end-of-life dates are for the versions pinned in
  lockfiles; other registry data describes the latest release. Quote the advisory id and source. Do not change code or dependencies because of it without the user asking.
- **Do not run repository scripts** to learn the architecture. Do not upload anything. There is no
  sync command.
- Numbers you derive (counts, token estimates) are estimates unless the tool measured them.
