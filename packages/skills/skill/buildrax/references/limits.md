# Limits to state honestly

- Languages: TypeScript, JavaScript and Python imports only. Functions, classes, routes, databases
  and data flow are not extracted yet.
- Imports through tsconfig `paths` aliases are reported as `unresolved`, not guessed.
- Dynamic imports with computed paths, plugin systems and dependency injection are invisible.
- Python absolute imports are resolved from the package root, `src/` and the repo root only.
- Standard-library and Node built-in imports are intentionally not shown as dependencies.
- The scan is a full re-scan each time (no incremental cache yet).
- Research covers npm and PyPI registry facts. Security advisories and the pinned version of each
  dependency are not used yet, so "is my version affected" cannot be answered.
- Token figures printed by the tools are estimates (about 4 characters per token).
