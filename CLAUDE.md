# BuildRAX Skills — project rules

## What this repo is

Open-source, local-first architecture intelligence: ingest a repo → Architecture IR → graph →
read-only viewer, plus agent skills (Claude Code, Codex, Antigravity) that call the same CLI.
Scope and open decisions: docs/scope.md.

## Stack

pnpm workspaces, Node >= 22, TypeScript strict, ESM only. tsup (packages), vitest, eslint + prettier.

## Package dependency rules (no cycles)

ir is the root. ingest, graph, research, cost depend on ir. pricing depends on cost.
viewer depends on ir + graph + cost; context on ir + graph.
skills has no internal dependencies. cli depends on all of them.
graph and cost must stay pure and browser-safe (no node: APIs). Viewer never extracts from source.
Only pricing (opt-in, allowlisted hosts) and research touch the network.
Skills contain instructions only; all logic lives behind the CLI.

## Hard rules

- Scanning is deterministic and spends zero LLM tokens. Never execute scanned repo code.
- The IR is written only by scans. The viewer is read-only; user notes are a separate overlay
  (.buildrax/notes.json) keyed by stable IDs and never mutate the IR.
- Every node/edge carries evidence or is explicitly marked inferred/unresolved with confidence.
- Stable, deterministic IDs. Same repo → same IDs.
- Source stays local. Research is opt-in (`--online`) and sends only validated public package names
  to allowlisted registry hosts. Notes are never sent anywhere and never appear in digest/context.
- Viewer works fully offline from one HTML file; escape all repo/user text.
- Don't present estimates as measured facts; don't invent prices.
- Tests ship with each feature. Schema changes bump the version and update docs.

## Commands

pnpm install · pnpm lint · pnpm typecheck · pnpm test · pnpm build

## Git

Conventional commits. Feature branches. No push or publish without explicit approval.


## Build Your Product in Public
After finishing any meaningful task, append an entry to `.buildinpublic/log/<today YYYY-MM-DD>.md` (create the file if needed):

### HH:MM - <short title>  (agent: <your name>)
- **What:** what was built or changed, in plain words
- **Why:** the problem or user need behind it
- **How:** key decision, trick or tradeoff (one or two lines)
- **Struggle:** what broke or took longest, if anything
- **Result:** measurable outcome or before/after, if any
- **Files:** main files touched
- **Tags:** any of #war-story #metric #decision #visual #lesson #milestone #pivot

When a moment is worth showing (tests going green after a long fight, a benchmark, a deploy, a new screen in a browser test), ask the user first: "Capture this for today's story? 1) terminal output 2) browser screenshot 3) skip". Only if they say yes, run the build-in-public skill's `scripts/capture.py` with `--approved`. Never capture without asking, and skip this if `.buildinpublic/config.json` has `"capture": "off"`.

If the user says just "help?" or "build in public help", list what they can say and run for Build Your Product in Public, numbered (run the skill's `scripts/menu.py`, which prints it all), ask which one, then do it.

Skip trivial changes. Never include secrets, keys, customer data or anything listed under Off-limits in `.buildinpublic/narrative.md`.
