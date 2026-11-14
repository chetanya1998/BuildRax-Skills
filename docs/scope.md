# Scope and open decisions

Product: see the master brief (P0 viewer + IR + graph + context + research; P1 cost, review, API
viewer; P2 simulation, editing, SaaS). Viewer is read-only; users may add sticky notes/flags.

## Open decisions (not yet made)

1. Parser: web-tree-sitter for TS/JS/Python (recommended) vs per-language adapters.
2. Viewer stack: decide by benchmark spike (React Flow vs custom SVG/canvas) at 1k/5k/20k nodes.
3. Repository naming/location (currently this repo, local commits only).
4. Search provider: pluggable, no-key default.
5. Notes: shared vs private default; agent-created notes.

Package names (`@buildrax/*`, `buildrax`) are placeholders; npm availability is unverified.

## Decisions taken for the first slice (revisit if wrong)

- Parser: web-tree-sitter 0.25.10 with tree-sitter-wasms 0.1.13 (newer web-tree-sitter versions cannot
  load these grammars, older ones fail too). tree-sitter-wasms is ~50 MB installed; consider shipping
  only the four needed grammars later.
- Viewer: vanilla TS + SVG + elkjs, single file. No benchmark spike yet; revisit before large graphs.
- Package names remain placeholders.
