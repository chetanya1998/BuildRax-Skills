# BuildRAX Skills

AI-native architecture intelligence for your repository: a deterministic, local scan builds a
code-linked architecture graph, shown in a read-only interactive viewer (with sticky notes and
flags for your own reference). Agent skills stay thin and use compact, token-bounded context.

> Status: first vertical slice (repo -> IR -> graph -> read-only viewer). See `docs/scope.md`.

## Try it

```bash
pnpm install && pnpm build
node packages/cli/dist/bin.js scan fixtures/sample-monorepo   # writes .buildrax/model.json
node packages/cli/dist/bin.js view fixtures/sample-monorepo --open
```

Scanning is static (tree-sitter), runs locally and uses no LLM tokens. The viewer is a single
offline HTML file. Click a node for upstream/downstream lineage, double-click a module to expand
it, and use the inspector for file:line evidence.

## Known limits (this slice)

- TS/JS/Python imports only; no functions, routes or data flow yet.
- tsconfig `paths` aliases are reported as unresolved rather than guessed.
- Full rescan every time (no incremental cache yet).
- The viewer bundle is ~1.5 MB because the ELK layout engine is inlined.
- Sticky notes/flags, research and the context engine are not built yet.

## Develop

```bash
pnpm install
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

Requires Node >= 20 and pnpm.
