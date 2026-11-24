# BuildRAX Skills

AI-native architecture intelligence for your repository: a deterministic, local scan builds a
code-linked architecture graph, shown in a read-only interactive viewer (with sticky notes and
flags for your own reference). Agent skills stay thin and use compact, token-bounded context.

> Status: early. Repo -> IR -> graph -> read-only viewer, infrastructure detection and a cost
> estimator. See `docs/scope.md` and `docs/roadmap.md`.

## Try it

```bash
pnpm install && pnpm build
alias buildrax="node $PWD/packages/cli/dist/bin.js"   # until it is published
buildrax scan fixtures/sample-monorepo
buildrax view fixtures/sample-monorepo --open
```

## Commands

| Command                                     | Purpose                                                                                                             |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `scan [--watch]`                            | static, incremental scan to `.buildrax/model.json` (no LLM tokens, no code execution); `--watch` rescans on changes |
| `digest` / `context "<question>"`           | compact, token-bounded context for agents (notes excluded)                                                          |
| `trace <target> [--direction up\|down]`     | transitive dependencies / change impact with `file:line`                                                            |
| `diff [--since <git ref>]`                  | architecture changes since the last scan or a commit (links, cycles, infra)                                         |
| `view` / `serve [--watch]`                  | read-only viewer; `serve` saves your sticky notes to `.buildrax/notes.json`; `--watch` rescans and offers a refresh |
| `notes`                                     | list your notes and flags                                                                                           |
| `research [--online]`                       | dependency facts from npm/PyPI; plan-only unless `--online`                                                         |
| `cost [--mode current\|product] [--online]` | monthly cost per traffic tier from dated AWS list prices (see `docs/cost.md`)                                       |
| `install-skill`                             | install the agent skill for Claude Code, Codex, Antigravity                                                         |

The viewer is one offline HTML file with two views of the same architecture (switch with the
**Graph | Nodes** buttons or `V`; selection, panels, notes and the Code tab are shared) and a
**Cost** view (`C`):

- **Nodes view**: a structured diagram. Rectangular cards in left-to-right layers, frames for
  services and folders, and right-angled arrows routed around the cards. Nothing moves on its own.
- **Graph view**: animated orbs, live physics and dotted segment boxes, for exploring.
- **Cost view** (after `buildrax cost`): the traffic tiers side by side, a stacked chart, the
  breakdown per component with low–high ranges, what changes between tiers, bottlenecks, which
  assumptions matter most, missing prices and dated price sources. Edit any assumption to
  recompute in the page (nothing is saved; the equivalent CLI command is shown).
- **Infrastructure** found by the scan (databases, caches, queues, storage, hosted APIs, compute)
  has its own segment box, colours and icons; the Inspector shows a priced node's monthly cost.
- **Step-by-step trace**: select a node and the Inspector's _Trace_ explains how it connects, one
  hop at a time (what it uses, what uses it), with the file:line of each link. Arrows in the Nodes
  view carry matching step numbers; step through with ◀ ▶ or press _Play_; filter to _Uses_ or
  _Used by_.

In the Graph view:

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
- **Focus** (`F`, or _Focus on this node_ in the Inspector), in either view: shows only the selected
  node and what connects to it (in the Graph view: dependents in columns to the left, dependencies
  to the right, one column per hop). The _Lineage depth_ setting limits how far it reaches;
  double-click a neighbour to move the focus; `Esc` returns. Kept in the shareable URL.
- **Compact top bar**: search, the Graph/Nodes switch, _Fit_ and a **Menu** that holds the rest
  (color, depth, Graph layout, theme, what to show, graph actions and the shortcut list).

See `docs/roadmap.md` for what comes next.

See `docs/privacy.md`, `docs/cost.md`, `docs/ci.md` (architecture map as a CI artifact),
`docs/schema.md` and `docs/agents.md`.

## Measured on this repo (estimates, chars / 4)

54 TypeScript files is about 40,500 tokens of raw source; `digest` is about 300 tokens; a
question-specific `context` pack is about 3,900 tokens.

## Known limits

- TS/JS/Python imports only; no functions, routes or data flow yet. Infrastructure comes from
  deploy/config files and SDK imports, not from runtime behaviour.
- Cost: AWS only, on-demand list prices, capacity from editable assumptions (not measurements);
  SaaS prices must be added to `.buildrax/prices.json` with source and date. See `docs/cost.md`.
- tsconfig `paths` aliases are reported as unresolved rather than guessed.
- Scans are incremental: unchanged files are not re-parsed (the model is identical to a full scan).
- Research uses npm/PyPI registry data only: no security advisories and no pinned-version
  comparison yet; findings describe the latest release.
- Agent skill install paths are unverified against vendor docs (see `docs/agents.md`).
- The viewer bundle is about 1.6 MB (inlined ELK layout engine). The physics itself is cheap
  (about 3 ms per step at 600 nodes) but the graph is drawn as SVG, so very large views (many
  hundreds of nodes on screen) have not been measured; collapse packages to stay responsive.
- Package names (`buildrax`, `@buildrax/*`) are placeholders and unpublished.
