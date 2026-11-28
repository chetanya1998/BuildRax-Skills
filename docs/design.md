# Design model (`buildrax design`)

A system-design view of the scanned repository, built deterministically from the model and its
side files (function index, rationale, research). No AI and no network. It lives in
`@buildrax/design`, a pure, browser-safe package, so the viewer can compute the same view.

Every element, relationship, concept and check carries a provenance label: **from code**, **from
config**, **documented**, **researched**, **inferred** (a rule drew a conclusion the files do not
state outright) or **AI inference, unverified** (only for reviews imported from your agent).

## C4 projection

| Level        | Elements                                                                                                                                                                           | Built from                        |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| 1 Context    | the system; **API clients** and **Web users** when endpoints or pages exist (inferred: who they are is not in the code); external services (payments, email, LLM, messaging, auth) | routes, infrastructure nodes      |
| 2 Containers | workspace packages, plus top-level folders that serve endpoints or consume queues; databases, caches, storage, search and queues                                                   | packages, routes, data operations |
| 3 Components | the folders inside each container (single-folder chains like `src` are skipped), plus the container's other files                                                                  | module tree                       |
| 4 Code       | files and functions (`buildrax fn`)                                                                                                                                                | function index                    |

- Container kinds: `app` (serves endpoints or pages), `worker` (consumes a queue), `service`
  (deployed through compose but neither), `library` (imported by other containers), else `app`.
- Component tags: `endpoints`, `pages`, `data access`, `messaging`, `worker`, `models`, `tests`.
- Relationships aggregate model edges: imports between containers or components, proven reads,
  writes, publishes and consumes (labelled with tables and queues), `uses` for client libraries,
  and endpoint or page counts from people.
- Deployment: compose services are tied to the container they build (`meta.buildContext`, from
  `build:`); other compute and hosting nodes are listed as deployment not tied to a folder.

## Concepts

A fixed catalogue of system-design concepts, each with a plain-language summary written once
for every repo, and a detector over evidence: HTTP API, pages, GraphQL, typed RPC, webhooks,
health checks, relational and document databases, ORM models, migrations, cache, **cache-aside**
(a function that reads the cache, then the database, then writes the cache, from the function
index), object storage, search, message queues, background workers, event streaming, monorepo,
shared libraries, endpoint-over-data-access layering, circular imports, containers,
orchestration, infrastructure as code, managed platforms, load balancers, multiple instances,
CDN, payments/email/LLM/auth providers, authentication libraries, input validation, rate
limiting, structured logging, tracing and metrics, error tracking, retries, circuit breakers,
feature flags, automated tests and static typing.

Package-based concepts match exact package names (or scopes such as `@opentelemetry/`) that the
code imports. Each hit lists where it shows up, evidence lines, and the decision records or doc
sections (rationale index) that name those places.

## NFR scorecard

Checks in seven categories: Reliability, Scalability, Performance, Security, Observability,
Maintainability, Data. Each is **present** (found, with evidence), **absent** (a static scan did
not see it; it may exist in a form the scan cannot recognise), **risk** (a problem was found, with
evidence) or **unknown** (needs `buildrax research --online`). Counts per category, never a grade.

Risk checks: circular imports, files imported by 15 or more files (or 10% of files), unresolved
imports, data-access folders importing endpoint folders, a database written by more than one
container, known advisories and end-of-life versions (from research).

## Agent review (AI, through your coding agent)

BuildRAX never calls a model. AI judgement comes from the coding agent you already use:

1. `buildrax design --pack` writes `.buildrax/design-pack.md`: rules, the design summary, the ids
   the agent may cite, recorded decisions and the exact JSON shape to return (a few thousand
   tokens). Notes are never included.
2. The agent reads the code, writes its review as JSON (`buildrax-design-review/v1`: items of type
   flaw, risk, strength, rationale or recommendation, each naming nodes, optional `file:line`
   evidence, optional HTTPS sources with the date read) and runs
   `buildrax design --import review.json`.
3. The CLI checks every item: ids must exist in the model or the design, evidence lines must fall
   inside scanned files, sources must be public HTTPS URLs, concept ids must be in the catalogue,
   and severity is only for flaws and risks. Any problem rejects the whole import with a list to
   fix; nothing is stored.
4. Accepted reviews go to `.buildrax/design-review.json`, separate from the model. `buildrax
design` shows them labelled **AI inference, unverified**, or **AI inference, cited** when the
   item names a source, and warns when the review was checked against an older scan.
