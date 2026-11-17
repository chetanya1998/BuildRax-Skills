# BuildRAX Skills

AI-native architecture intelligence for your repository: a deterministic, local scan builds a
code-linked architecture graph, shown in a read-only interactive viewer (with sticky notes and
flags for your own reference). Agent skills stay thin and use compact, token-bounded context.

> Status: first vertical slice (repo -> IR -> graph -> read-only viewer). See `docs/scope.md`.

## Try it

```bash
pnpm install && pnpm build
alias buildrax="node $PWD/packages/cli/dist/bin.js"   # until it is published
buildrax scan fixtures/sample-monorepo
buildrax view fixtures/sample-monorepo --open
```

## Commands

| Command                                 | Purpose                                                                     |
| --------------------------------------- | --------------------------------------------------------------------------- |
| `scan`                                  | static scan to `.buildrax/model.json` (no LLM tokens, no code execution)    |
| `digest` / `context "<question>"`       | compact, token-bounded context for agents (notes excluded)                  |
| `trace <target> [--direction up\|down]` | transitive dependencies / change impact with `file:line`                    |
| `view` / `serve`                        | read-only viewer; `serve` saves your sticky notes to `.buildrax/notes.json` |
| `notes`                                 | list your notes and flags                                                   |
| `research [--online]`                   | dependency facts from npm/PyPI; plan-only unless `--online`                 |
| `install-skill`                         | install the agent skill for Claude Code, Codex, Antigravity                 |

The viewer is one offline HTML file: click for upstream/downstream lineage, double-click a module
to expand, sticky notes and flags for your own reference (the architecture itself is read-only).
See `docs/privacy.md` and `docs/agents.md`.

## Measured on this repo (estimates, chars / 4)

54 TypeScript files is about 40,500 tokens of raw source; `digest` is about 300 tokens; a
question-specific `context` pack is about 3,900 tokens.

## Known limits

- TS/JS/Python imports only; no functions, routes, databases or data flow yet.
- tsconfig `paths` aliases are reported as unresolved rather than guessed.
- Full rescan every time (no incremental cache yet).
- Research uses npm/PyPI registry data only: no security advisories and no pinned-version
  comparison yet; findings describe the latest release.
- Agent skill install paths are unverified against vendor docs (see `docs/agents.md`).
- The viewer bundle is about 1.5 MB (inlined ELK layout engine); large graphs are unbenchmarked.
- Package names (`buildrax`, `@buildrax/*`) are placeholders and unpublished.
