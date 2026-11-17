# BuildRAX commands

All commands take an optional `[path]` (default `.`) and work offline except `research --online`.

| Command                                                             | What it does                                                                                                                                       |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scan [path] [--json]`                                              | Static scan to `.buildrax/model.json`. Prints files, modules, externals, unresolved imports, circular dependencies, most-connected files.          |
| `digest [path] [--level 0\|1] [--budget N] [--json]`                | Compact overview. Level 0 = packages, level 1 = packages plus directories.                                                                         |
| `context "<question>" [path] [--budget N] [--snippets] [--json]`    | Bounded, ranked evidence for a question. Falls back to the digest when nothing matches.                                                            |
| `trace <target> [path] [--direction up\|down] [--depth N] [--json]` | Transitive dependency walk with `file:line` for the first link of each result.                                                                     |
| `view [path] [--open]`                                              | Writes `.buildrax/view.html`, a single offline file.                                                                                               |
| `serve [path] [--port N] [--open]`                                  | Local viewer on 127.0.0.1; notes are saved to `.buildrax/notes.json`.                                                                              |
| `notes [path] [--all] [--json]`                                     | Lists the user's sticky notes and flags. Read-only.                                                                                                |
| `research [path] [--online] [--limit N] [--no-cache] [--json]`      | Without `--online`: shows the exact requests, sends nothing. With it: fetches npm/PyPI facts for dependencies. Only public package names are sent. |
| `install-skill [--target T] [--scope S]`                            | Installs this skill for Claude Code, Codex or Antigravity.                                                                                         |

`<target>` for `trace` can be a node id (`file:src/a.ts`), a file or module path, or a name.

## Files in `.buildrax/`

- `model.json`: the architecture model (written by `scan` only).
- `notes.json`: the user's notes (written by the viewer through `serve`, or by import).
- `research.json`: dated, source-linked findings from `research --online`.
- `view.html`: generated viewer. `cache/`: research response cache.
