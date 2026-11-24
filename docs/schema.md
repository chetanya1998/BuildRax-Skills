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
