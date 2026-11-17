# BuildRAX Skills — project rules

## What this repo is

Open-source, local-first architecture intelligence: ingest a repo → Architecture IR → graph →
read-only viewer, plus agent skills (Claude Code, Codex, Antigravity) that call the same CLI.
Scope and open decisions: docs/scope.md.

## Stack

pnpm workspaces, Node >= 20, TypeScript strict, ESM only. tsup (packages), vitest, eslint + prettier.

## Package dependency rules (no cycles)

ir is the root. ingest, graph, research depend on ir. viewer and context depend on ir + graph.
skills has no internal dependencies. cli depends on all of them.
graph must stay pure and browser-safe (no node: APIs). Viewer never extracts from source.
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
