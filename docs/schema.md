# Architecture IR (`buildrax-ir`)

`.buildrax/model.json` is written only by `buildrax scan`. The viewer, CLI, context, research and
cost features all read it.

| Version          | What changed                                                                                                                                       |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `buildrax-ir/v1` | Projects, modules, files, external packages, unresolved imports; `imports` / `depends-on` edges.                                                   |
| `buildrax-ir/v2` | **Infrastructure**: new node kinds and the `uses` edge. v1 files are still read (they simply have no infrastructure nodes); scans always write v2. |

## Nodes

`{ id, kind, name, parent?, path?, language?, evidence[], meta? }`. IDs are deterministic
(`<kind>:<key>`), so the same repo always produces the same IDs.

Code kinds: `project`, `module`, `file`, `class`, `function`, `route`, `service`, `external`,
`unresolved`.

Infrastructure kinds (v2): `compute`, `hosting`, `database`, `cache`, `queue`, `storage`, `cdn`,
`email`, `payments`, `llm`, `messaging`, `search`, `auth`. They carry `meta.infra = true` and,
only when a file declares them, sizing facts:

| meta field                                | Meaning                                                                                                                    |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `provider`, `engine`, `version`           | e.g. `aws`, `postgres`, `16.3`                                                                                             |
| `instanceType`                            | e.g. `db.t4g.small`, `cache.t4g.micro`, a fly/render plan                                                                  |
| `replicas`, `cpu` (vCPU each), `memoryMb` | from compose `deploy`, ECS tasks, Kubernetes requests                                                                      |
| `storageGb`, `multiAz`                    | databases                                                                                                                  |
| `runtime`, `image`, `plan`                | containers and platforms                                                                                                   |
| `sources`                                 | which kinds of files mentioned it (`terraform`, `kubernetes`, `platform`, `compose`, `dockerfile`, `prisma`, `sdk`, `env`) |
| `confidence`                              | `0.4` when the service was seen only through an environment variable **name**                                              |

When sources disagree, the more authoritative one wins: Terraform > Kubernetes > platform files >
compose / Dockerfile / Prisma > SDK usage > env names. Values that are expressions (`var.size`,
`"${...}"`) are never treated as sizes.

### Versions and runtimes (optional facts, v2)

Added without a format change (optional `meta` fields; older readers ignore them):

- `external` nodes: `meta.version` (one pinned version) or `meta.versions` (several, e.g. in a
  monorepo), from `package-lock.json`, `npm-shrinkwrap.json`, `pnpm-lock.yaml`, `yarn.lock`,
  `poetry.lock`, `uv.lock`, `requirements*.txt` (exact `==` pins only) and `Pipfile.lock`, with a
  `config` evidence entry per lockfile line (`locked 4.21.2`). Ranges are never treated as versions.
- `project` node: `meta.runtimes` = `[{ product, declared, version, file }]` from root
  `package.json` `engines.node`, `.nvmrc`, `.node-version`, `.python-version` and `pyproject.toml`
  `requires-python`; `version` is the oldest version the declaration allows.

### Routes (endpoints)

`route` nodes (`route:<package dir>:<METHOD> <path>`, or `route:<file>:<line>:<METHOD>` when the
path is computed at runtime) are children of the file that defines them, with `verified` evidence
(or `unresolved` for computed paths). `meta`: `method` (`GET`… , `ANY`, `PAGE` for UI pages,
`WS`), `path` (with every router prefix applied), `framework`, `type` (`api` | `page`),
`handler` when the handler is a named function. Detected for Next.js, Express, Fastify, Hono,
Koa, NestJS, FastAPI and Flask. No format change: `route` was already a node kind.

## Edges

`{ id: "<from>-><kind>-><to>", from, to, kind, evidence[] }`. Kinds: `imports`, `depends-on`,
`calls`, `reads`, `writes`, `publishes`, `consumes`, and (v2) `uses`: a file that imports a
client library uses that service (verified, with the import line), and a compose service that
`depends_on` another uses it (config).

## Evidence

Every node and edge has at least one: `{ kind, file?, startLine?, endLine?, detail? }` where kind
is `verified` (from code), `config` (manifests and deploy files), `inferred` (a heuristic, e.g.
directory grouping or an env variable name), `unresolved`, or `user-proposed`.

## What is never read

Scanning is static: no repository code is executed. For environment files only
`.env.example` / `.env.sample` / `.env.template` / `.env.dist` are opened, and only variable
names are used. A real `.env` is never opened.

## Research file (`buildrax-research`)

`.buildrax/research.json`, written by `buildrax research --online`. `v2` adds the `lifecycle`
evidence type (end-of-life and support dates); `v1` files are still read. Evidence types:
`registry-metadata`, `docs-link`, `advisory` (OSV.dev, for the pinned version), `lifecycle`
(endoflife.date). Every finding has a source URL, publisher, retrieval date and reliability.
