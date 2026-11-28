# Architecture IR (`buildrax-ir`)

`.buildrax/model.json` is written only by `buildrax scan`. The viewer, CLI, context, research and
cost features all read it.

| Version          | What changed                                                                                                                                       |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `buildrax-ir/v1` | Projects, modules, files, external packages, unresolved imports; `imports` / `depends-on` edges.                                                   |
| `buildrax-ir/v2` | **Infrastructure**: new node kinds and the `uses` edge. v1 files are still read (they simply have no infrastructure nodes); scans always write v2. |
| `buildrax-ir/v3` | **Data models**: the `entity` node kind and the `relates` edge. v1 and v2 files are still read; scans always write v3.                             |

## Nodes

`{ id, kind, name, parent?, path?, language?, evidence[], meta? }`. IDs are deterministic
(`<kind>:<key>`), so the same repo always produces the same IDs.

Code kinds: `project`, `module`, `file`, `class`, `function`, `route`, `service`, `external`,
`unresolved`, and (v3) `entity`.

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
| `buildContext`                            | compose services built from the repo: the folder (`.` for the root)                                                        |
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

### Data operations

`reads` / `writes` edges from a file to a database or cache, and `publishes` / `consumes` edges
to a queue, found from client calls: Prisma, SQL clients and `sql` tags (classified by the SQL
literal), Drizzle, Supabase, TypeORM, MongoDB/Mongoose, Redis, BullMQ, Kafka, SQS, RabbitMQ,
Django ORM, SQLAlchemy and Celery. A call counts only with proof: a client of that family created
in the file, a receiver imported from a repo file that holds such a client or uses that
infrastructure, or (for an SQL literal) the file importing a database library. Edge `meta`:
`tables` (tables, models, collections or cache keys when literal), `channels` (queue, topic or
task names), `functions` (enclosing functions) and `systems`. Evidence is `verified`, or
`inferred` when the target is only "the one database in the project". When a table or model
name matches a known data model, `meta.entities` lists those entity IDs.

### Data models (v3)

`entity` nodes, one per declared model: Prisma `model` blocks (`*.prisma`), TypeORM `@Entity`
classes, Drizzle `pgTable` / `mysqlTable` / `sqliteTable`, Mongoose `mongoose.model("Name")`,
Django `models.Model` subclasses and SQLAlchemy / SQLModel classes. ID
`entity:<file>:<Name>`, evidence `verified` at the declaration line. `parent` is the database
Prisma's datasource points at, else the database the declaring file uses, else the only database
in the project, else the project. `meta`: `orm`, `table` (when declared: `@@map`,
`__tablename__`, `@Entity("orders")`, the Drizzle table name), and `fields` (`name`, `type`,
`pk`; at most 60, with `moreFields` for the rest). Only literal names are read; nothing is
executed.

`relates` edges join entities: Prisma relation fields, TypeORM `@ManyToOne` / `@OneToMany` /
`@OneToOne` / `@ManyToMany`, Drizzle `.references(() => t.col)`, Django `ForeignKey` /
`OneToOneField` / `ManyToManyField`, SQLAlchemy `ForeignKey("table.col")` and `relationship("X")`.
`meta.fields` names the fields, `meta.many` marks to-many sides. A target is matched in the same
file first, then among models of the same ORM; a relation with no single match is left out and
counted, never guessed.

### Routes (endpoints)

`route` nodes (`route:<package dir>:<METHOD> <path>`, or `route:<file>:<line>:<METHOD>` when the
path is computed at runtime) are children of the file that defines them, with `verified` evidence
(or `unresolved` for computed paths). `meta`: `method` (`GET`… , `ANY`, `PAGE` for UI pages,
`WS`), `path` (with every router prefix applied), `framework`, `type` (`api` | `page`),
`handler` when the handler is a named function. Detected for Next.js, Express, Fastify, Hono,
Koa, NestJS, FastAPI and Flask. No format change: `route` was already a node kind.

## Edges

`{ id: "<from>-><kind>-><to>", from, to, kind, evidence[] }`. Kinds: `imports`, `depends-on`,
`calls`, `reads`, `writes`, `publishes`, `consumes`, (v3) `relates` between data models, and (v2) `uses`: a file that imports a
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

## Function index (`buildrax-functions`)

`.buildrax/functions.json`, written by `buildrax scan` next to the model and read only when
someone drills in (`buildrax fn`, the inspector's Functions section). It is derived and
git-ignored. `v1`:

- `files[]`: `{ path, functions[] }`, sorted by path; functions in source order.
- Function: `id` (`fn:<file>#<name>`, `@<line>` added when a file declares the name twice),
  `name` (`save`, `Class.method`, `outer.inner`, or `router.get("/x")` / `new Worker("emails")`
  for an inline callback with a block body or a literal first argument), `kind` (`function`,
  `method`, `arrow`, `callback`), `line`, `endLine`, `exported`, `async`.
- `calls[]`: `{ name, line, count?, to, via }`, only resolved calls. `via`: `local` (same file,
  including `this.x()` / `self.x()` and nested helpers), `import` (a function in the repo file
  the name is imported from), `file` (that file, when the function itself is not matched, e.g.
  `db.query`), `workspace` (an exported function of a workspace package, or the package), or
  `external` (the package node). `otherCalls` counts the rest: built-ins, parameters, locals.
- `ops[]`: the proven data operations (from `reads` / `writes` / `publishes` / `consumes` edge
  evidence) inside the function, by line range. `routes[]`: route nodes it handles.
  `calledBy[]`: functions with a resolved call to it.

Matching is by name; nothing is executed and types are not inferred.

## Rationale index (`buildrax-rationale`)

`.buildrax/rationale.json`, written by `buildrax scan` (git-ignored, local only). It quotes why
things are built the way they are; it never changes the model. `v1`:

- `sources[]`, each `{ id, kind, title, file?, line?, endLine?, status?, date?, hash?, fn?,
excerpt, links[] }`. Kinds and their provenance label:
  - `adr` (Documented, decision record): Markdown under `adr/`, `adrs/`, `decisions/`,
    `decision-records/`, `architecture-decisions/`, or named `ADR-12…`. Title, `status`
    ("Status: Accepted" or a Status section), `date`, and the Decision section (else the first
    paragraph) as the excerpt. One that names nothing links to the project.
  - `doc` (Documented): sections of READMEs, `ARCHITECTURE.md`, `DESIGN.md` and `docs/` pages,
    split by heading; kept only when they name something in the model.
  - `comment` (From code): comments with wording that gives a reason ("because", "to avoid",
    "instead of", "on purpose", "workaround", NOTE/HACK, …); licence headers and tool directives
    are skipped. `fn` is the function it documents (just above it) or sits in.
  - `commit` (From git history): local commits (no merges, newest 400) whose message has a body or
    reason wording; trailers are dropped and authors are not read. Linked to the files they
    changed, or to the packages when they changed more than 15 files.
- `links[]`: `{ node, via }`. `via`: `path` (a repo path in the text), `code` (an exact
  `code span`: file, package, model, table, route), `name` (an infrastructure service, a database
  engine word, a route path, or a well-known framework name; words that are also English, like
  Express or React, only when capitalised), `location`, `changed`, `project`. Matching is exact,
  never fuzzy, and ties nothing it cannot name.
- `byNode`: node id → source ids (decisions, docs, comments, then at most 8 newest commits).
- `git`: whether history was read (`--no-git`, not a repository, or no git means `read: false`).

## Research file (`buildrax-research`)

`.buildrax/research.json`, written by `buildrax research --online`. `v2` adds the `lifecycle`
evidence type (end-of-life and support dates); `v1` files are still read. Evidence types:
`registry-metadata`, `docs-link`, `advisory` (OSV.dev, for the pinned version), `lifecycle`
(endoflife.date). Every finding has a source URL, publisher, retrieval date and reliability.
