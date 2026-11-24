# Cost estimator

`buildrax cost` estimates what a project costs to run per month at five traffic tiers
(100, 1k, 10k, 100k and 1M users by default). It is an **estimate**: AWS on-demand list prices in
USD, before tax, free tiers, credits, discounts and reserved pricing.

```bash
buildrax scan .
buildrax cost                       # current project, cached prices only (prints what it would fetch)
buildrax cost --online              # download AWS list prices for the region first (opt-in)
buildrax cost --mode product        # "what if this became a product?" asks a few stack questions
buildrax cost --mode product --yes --stack database=mysql,cache=none --assume dauRatio=0.3
buildrax view --open                # then press Cost (or C)
```

## Modes

| Mode                | Components                                                                                                                                                                    |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `current` (default) | What the scan detected. Declared sizes (Terraform instance classes, replicas, CPU/memory) are priced while they are big enough.                                               |
| `product`           | A hypothesis. A short questionnaire with defaults pre-selected from the scan: region, CPU, database, cache, storage, workers, frontend hosting, email, payments, AI API, SMS. |

The default AWS stack is Fargate containers behind an Application Load Balancer, RDS (PostgreSQL or
MySQL), ElastiCache (Redis or Valkey), S3, internet data transfer and SES.

## Traffic → capacity → cost

Every number below is an editable assumption (`buildrax cost --list-assumptions`, `--assume k=v`,
or the editor in the viewer's Cost view):

1. users × share active per day (20%) = daily active users;
2. × requests per active user per day (60) / 86,400 = average requests/second; × peak factor (3) =
   peak requests/second;
3. containers = peak ÷ (requests/second per vCPU × vCPU per container), at least 2 from the
   redundancy threshold (10k users), autoscaling noted;
4. database: peak queries/second ÷ queries per vCPU → the smallest class whose sustained vCPU is
   enough (burstable `t4g` classes count only their baseline), Multi-AZ from the redundancy
   threshold, read replicas beyond the largest class; connections from all containers are checked
   against the class's default `max_connections`;
5. cache memory per 1,000 daily users → the smallest node with 25% headroom, primary + replica
   from the redundancy threshold, shards beyond the largest node;
6. data per user → database storage (gp3, at least 20 GB); files per user → S3; response size →
   data transfer out and load balancer capacity units;
7. emails, payments, AI calls and SMS per user → usage-priced services.

The low and high columns rerun the same model with lower and higher traffic (share active,
requests per user and peak factor). "Most sensitive to" reruns each assumption at +50%.
Bottlenecks and per-tier changes come from the same model, so cost and scaling advice never
disagree.

## Prices

| Source                                                              | When                                 | Recorded with                                  |
| ------------------------------------------------------------------- | ------------------------------------ | ---------------------------------------------- |
| AWS Price List public files (`pricing.us-east-1.amazonaws.com`)     | `--online`                           | file URL, AWS publication date, retrieval date |
| AWS Price List Query API (`api.pricing.us-east-1.amazonaws.com`)    | `--online --use-credentials`         | API URL, publication date, retrieval date      |
| `.buildrax/prices.json` (you or an agent, from the provider's page) | always, overrides list prices by key | your source URL and retrieval date (required)  |

Only the handful of prices an estimate can use are kept (about 60 records per region) in
`.buildrax/cache/pricing/aws-<region>.json`. EC2's 0.5 GB price file is never downloaded.

Anything without a price is shown as **price needed** with a link to the provider's pricing page
and excluded from totals (marked with `+`); BuildRAX never invents prices. Detected services it has
no model for (other queues, search, auth, CDN…) are listed as **not priced**.

`prices.json` format (`buildrax-prices/v1`):

```json
{
  "schemaVersion": "buildrax-prices/v1",
  "currency": "USD",
  "region": "global",
  "records": [
    {
      "key": "payments.stripe.percent",
      "label": "Stripe card fee (domestic)",
      "unit": "percent",
      "tiers": [{ "from": 0, "usd": 2.9 }],
      "provider": "stripe",
      "sourceUrl": "https://stripe.com/pricing",
      "retrievedAt": "YYYY-MM-DD",
      "evidenceType": "researched-page"
    }
  ]
}
```

Keys the report asks for are listed under "Prices needed" (`payments.<p>.percent|fixed`,
`llm.<p>.input|output` per million tokens, `email.<p>.per-email`, `messaging.<p>.per-sms`,
`hosting.<p>.monthly`).

## Output

`.buildrax/cost.json` (`buildrax-cost/v1`): mode, region, stack, assumptions, and per tier the
users, daily actives, average and peak requests/second, each component (category, sizing, line
items with quantity, unit and price key, monthly low/expected/high, notes, the IR node it prices),
totals, bottlenecks, changes and sensitivity; plus every price source used, missing prices and
unpriced services. `buildrax view` embeds it (with `cost-prices.json`, the prices the viewer may
need to recompute).

## Not modelled yet

Reserved instances and savings plans, free tiers, S3 request charges, NAT gateways, logging and
monitoring, backups, support plans, GCP and Azure.
