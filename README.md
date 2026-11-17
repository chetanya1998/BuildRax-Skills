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

The viewer is one offline HTML file with an animated, interactive graph:

- **Live physics layout** (default): drag any node and its neighbours follow elastically; dragged
  nodes stay pinned (Alt-click or _Unpin_ releases them, _Shake_ re-runs the physics). **Layered**
  gives a structured left-to-right layout. Switching, expanding and collapsing all animate: nodes
  glide to their new places and new ones burst out of their parent.
- **Code segmentation boxes** (_segments_): every expanded service, package or folder is drawn as a
  dotted box around its files, nested like the code (service › folder › files). External
  dependencies and unresolved imports get their own boxes. Boxes never overlap: the layout keeps
  them apart in both modes. Drag a box by its header to move the whole segment, click the header to
  inspect it, or press **−** to collapse it back into one node.
- **Color coding**: by package, kind, language or connectivity (heat), with a clickable legend that
  focuses one color. Orb size reflects files (containers) or connections (files); cycles pulse red.
- **Click a node** to light up everything upstream (orange) and downstream (blue) with animated
  flow along the links; the camera glides to it. A minimap and zoom controls help navigation.
- **Code tab** shows that node's code plus the connecting lines and files on both sides.
- Light/dark/auto themes (remembered), sticky notes and flags for your own reference, and a
  _motion_ toggle. The OS "reduce motion" setting is honoured (static layout, no particles).
- **Make room for the graph**: each sidebar can be hidden (a small tab on the canvas edge brings
  it back) or detached into a floating window you drag by its grip and resize, then dock again.
  The minimap has a close button (and a map toggle under the zoom buttons); the legend can be
  minimized. Shortcuts: `[` Overview, `]` Inspector, `M` minimap, `/` search. Your layout is
  remembered in this browser, and the graph stays where you were looking when panels change.
- **Node view** (`F`, or _Open node view_ in the Inspector): shows only the selected node, with what
  depends on it in columns to the left and what it depends on to the right, one column per hop.
  The _Lineage depth_ setting limits how far it reaches; double-click a neighbour to move the
  focus to it; `Esc` returns to the full graph. The view is kept in the shareable URL.
- **Compact top bar**: search, the Layered/Live switch, _Fit_ and a **Menu** that holds the rest
  (color, depth, theme, what to show, graph actions and the shortcut list).

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
- The viewer bundle is about 1.6 MB (inlined ELK layout engine). The physics itself is cheap
  (about 3 ms per step at 600 nodes) but the graph is drawn as SVG, so very large views (many
  hundreds of nodes on screen) have not been measured; collapse packages to stay responsive.
- Package names (`buildrax`, `@buildrax/*`) are placeholders and unpublished.
