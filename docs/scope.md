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
