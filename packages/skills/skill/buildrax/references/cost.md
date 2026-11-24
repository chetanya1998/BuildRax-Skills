# Cost questions

Use `buildrax cost` for anything about what the project costs to run or would cost as a product.
Never estimate cloud bills from memory, and never type a price you did not get from BuildRAX output
or from a provider page the user agreed you could read.

## Two modes

- **Current project** (`--mode current`, default): prices what the scan detected (Terraform,
  Kubernetes, compose, platform files, SDK usage). Declared sizes are used while they are enough;
  the output says when a traffic tier outgrows them.
- **As a product** (`--mode product`): a hypothesis. Before running it, **ask the user** about the
  stack, offering the detected defaults (the command prints them; Enter keeps each one):
  region, container CPU (x86/ARM), database, cache, file storage, background workers, frontend
  hosting, email, payments, AI API, SMS. Keep it to these questions. Pass the answers with
  `--stack key=value,...` and `--yes`.

Both model five tiers by default (`--tiers 100,1k,10k,100k,1m`) and print low / expected / high
monthly ranges, what changes between tiers, bottlenecks to watch, and the assumptions that move
the total most.

## Prices

- AWS list prices come from the public AWS Price List. They are used only once cached:
  run `buildrax cost` first (it shows what it would download), then `buildrax cost --online`
  **only after the user agrees**. Nothing about the repository is sent.
- Stripe fees, LLM tokens, SendGrid, Twilio, Vercel and similar have no price API. The report lists
  them as "price needed" with the provider's pricing page. If the user asks you to fill them, read
  the page and add entries to `.buildrax/prices.json` with `sourceUrl` and `retrievedAt` (the file
  is validated; entries without both are rejected). Tell the user which prices you added.
- `--use-credentials` (AWS Price List API) is optional and only with the user's explicit request.
  Credentials come from the environment; never ask the user to paste keys into the chat, and never
  print, store or pass them on.

## How to answer

1. State the mode, region and stack used, and that the figures are **estimates** of on-demand list
   prices (no free tiers, credits, discounts or tax).
2. Quote the expected figure with its low–high range, per tier asked about.
3. Name the assumptions that matter most (from "most sensitive to") and offer to rerun with the
   user's numbers: `--assume dauRatio=0.3,requestsPerDau=120` (`--list-assumptions` shows all).
4. List every "price needed" and "detected but not priced" item; the total excludes them.
5. Point to the viewer's **Cost** view (`buildrax view --open`, then the Cost button) for the
   breakdown, chart and an assumptions editor.

Do not present a tier as a guarantee of feasibility: bottlenecks are model-based warnings, not
load-test results.
