# Limits to state honestly

- Languages: TypeScript, JavaScript and Python imports only. Functions, classes, routes, databases
  and data flow are not extracted yet.
- tsconfig/jsconfig `paths` and `baseUrl` aliases are resolved; `extends` only for relative configs.
- Endpoints: Next.js (app/pages routers), Express, Fastify, Hono, Koa, NestJS, FastAPI, Flask. Route
  prefixes are followed across files through imports; runtime-built paths are listed as computed.
  Flows are file-level (what the handler's file can reach), not one exact runtime path; database
  reads vs writes and queue publish/consume are not separated yet.
- Dynamic imports with computed paths, plugin systems and dependency injection are invisible.
- Python absolute imports are resolved from the package root, `src/` and the repo root only.
- Standard-library and Node built-in imports are intentionally not shown as dependencies.
- Research: npm/PyPI registry facts, OSV.dev advisories for versions pinned in lockfiles
  (package-lock, pnpm, yarn, poetry, uv, requirements, Pipfile), and endoflife.date support dates
  for runtimes, databases and major frameworks. Packages without a lockfile pin get no advisory
  check (a version range is not a version). Python import names that differ from the
  distribution name (`yaml` vs `PyYAML`) are not matched.
- Token figures printed by the tools are estimates (about 4 characters per token).
- Cost: AWS only (Fargate, RDS PostgreSQL/MySQL, ElastiCache, S3, ALB, data transfer, SES), on-demand
  list prices. No reserved/savings plans, free tiers, request charges, NAT, logging or support
  plans. SaaS prices must be researched into `.buildrax/prices.json`. Detected queues other than
  workers, search and auth services are listed but not priced. Capacity comes from editable
  assumptions, not from measurements.
