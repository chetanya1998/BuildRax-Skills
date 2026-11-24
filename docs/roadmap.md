# Roadmap

Decisions agreed with the product owner (2026-11-22) and the work they imply. Order matters:
each step builds on the previous one.

1. **Graph and Nodes views + step-by-step trace** — done (see README).
2. **Infrastructure detection** — done (IR v2, `docs/schema.md`).
3. **Cost estimator** — done for AWS (`docs/cost.md`); see _Cost: next_ below.
4. Pinned versions from lockfiles → security advisories in research.
5. Incremental scanning; large-graph benchmark (settles the open viewer-technology decision).
6. Verify the agent skill in real Claude Code, Codex and Antigravity sessions.

## 2. Infrastructure detection (prerequisite for cost)

Static only, like the rest of the scanner; nothing is executed.

- Sources: `docker-compose*.yml`, Dockerfiles, Terraform (`aws_*`, `google_*`, `azurerm_*`
  resources), Kubernetes manifests (replicas, CPU/memory requests), `serverless.yml`, `vercel.json`,
  `netlify.toml`, `fly.toml`, `render.yaml`, `Procfile`, `.github/workflows` deploy steps.
- SDK usage already seen by the scanner maps to paid services (Stripe, OpenAI/Anthropic, S3,
  SendGrid/Resend, Twilio, Redis, BullMQ, Kafka).
- Output: new IR node kinds (`database`, `cache`, `queue`, `storage`, `compute`, `cdn`,
  `external-api`) with `meta` such as provider, engine, instance size and replicas when declared.
  Anything guessed is `inferred` with a confidence. This is a schema change, so it ships as
  `buildrax-ir/v2` with migration and docs.

## 3. Cost estimator

### Principles

- Every price has a source URL, a retrieval date, a region and a currency. No invented prices.
- Every assumption is visible and editable; results are ranges (low / expected / high) and are
  always labelled as estimates.
- Software licences, infrastructure, managed services and per-call APIs are kept apart; a package
  dependency is not a bill.
- Price lookups are opt-in (`--online`), show their plan first, and reuse the research engine's
  safety rules (allowlisted hosts, local cache). Pricing data and maths live in their own package.

### Two modes

**A. Current project** — cost of what the repo actually uses (from infrastructure detection).

**B. As a product (hypothesis)** — when the user asks "what if this became a product?":

1. Build the project context (digest: stack, components, external services).
2. Ask the user a short questionnaire with **minimal defaults** pre-selected from the detected
   stack: frontend hosting, backend runtime, database, cache, file storage, auth, email, payments,
   AI usage, cloud and region. One click accepts the defaults.
3. Optionally research (opt-in) what infrastructure each tier typically needs.
4. Model five traffic tiers: **100 → 1,000 → 10,000 → 100,000 → 1,000,000 users**.
5. Per tier: required components (e.g. single instance → load balancer and autoscaling → read
   replicas, cache and CDN → multi-zone, queues and sharding), monthly cost range, likely
   bottlenecks and what has to change to reach the next tier: a **feasibility** view.

Tier architectures come from versioned, editable templates, shown as assumptions, never as fact.

### Traffic → capacity → cost model

Users → daily active users (default 20%) → requests per active user per day (default 50) →
peak requests per second (peak factor 3) → compute units, database connections and size, storage
growth, outbound traffic, emails, payments, AI tokens. The same capacity assumptions feed the
scaling analysis, so cost and scaling never contradict each other. The output includes which
assumption moves the total most, and what information is missing.

### Prices

| Source                                                                                                   | Access                           | Notes                                                                                                                                                         |
| -------------------------------------------------------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AWS Price List (public files)                                                                            | No account needed                | Verified reachable. Files are large (RDS us-east-1 ≈ 32 MB, EC2 us-east-1 ≈ 482 MB): stream them, keep only the needed lines, cache locally. Published daily. |
| AWS Price List Query API                                                                                 | Optional user credentials        | Smaller, targeted lookups.                                                                                                                                    |
| Azure Retail Prices API                                                                                  | Public                           | Blocked by the build sandbox's network; to verify on a normal machine.                                                                                        |
| Google Cloud Billing Catalog                                                                             | API key required                 | Optional.                                                                                                                                                     |
| SaaS without price APIs (Vercel, Supabase, Neon, Render, Fly, Stripe fees, SendGrid, Twilio, LLM tokens) | Versioned price list in the repo | Each entry has source URL and date; a checker flags entries whose page no longer shows that price.                                                            |

Default provider set is minimal (AWS plus the common SaaS list); more providers are asked for, not
assumed. The user's own contract prices or discounts (`.buildrax/cost.json`) override list prices.

### Optional cloud credentials (high security)

- **Off by default.** Used only with an explicit flag (e.g. `--use-credentials`) per run.
- **Never stored by BuildRAX in files**: not in the repo, the model, notes, `cost.json` or logs.
  Read from the OS keychain (macOS Keychain, Windows Credential Manager, libsecret) or the standard
  provider credential chain / environment variables.
- **Least privilege**: documented read-only policy (`pricing:GetProducts`,
  `pricing:DescribeServices`, `pricing:GetAttributeValues`); a Google API key restricted to the
  Cloud Billing Catalog API.
- **Isolated use**: only the pricing fetcher sees credentials; requests go only to allowlisted
  pricing hosts; credentials are never passed to the agent or any LLM and are redacted from errors.
- `buildrax cost credentials status|clear`; tests for redaction, host allowlisting and
  no-persistence.

### Deliverables

- `@buildrax/pricing` (sources, price records, catalog + checker), cost model in its own package.
- `buildrax cost [--mode current|product] [--tiers 100,1k,10k,100k,1m] [--provider aws --region …]
[--online] [--use-credentials]` → `.buildrax/cost.json` (`buildrax-cost/v1`).
- Viewer **Cost** tab: tiers side by side, per-component breakdown, stacked chart, assumptions
  editor, cost badges/colouring on both views, sources with dates.
- Skill: cost questions always state assumptions and ask for missing stack / traffic details.

## Cost: next

Shipped (2026-11-24): pure cost model, AWS public price files and optional signed Price List API,
`buildrax cost` (both modes, tiers, assumptions, sensitivity), viewer Cost view, skill guidance.

Still open:

- OS keychain storage for credentials (today: environment only, nothing stored).
- A checker that flags `.buildrax/prices.json` entries older than N days or whose page changed.
- Versioned tier templates (architecture per tier) editable as files; today the tier logic is code
  with editable numeric assumptions.
- More components: SQS, CloudFront, NAT gateway, CloudWatch logs, backups, OpenSearch; reserved /
  savings-plan pricing; Azure Retail Prices and Google Cloud Billing Catalog.
- Cost badges on nodes in the Graph and Nodes views (the Inspector shows cost today).
