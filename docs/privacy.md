# Privacy: what stays local and what is sent

| Feature                                                                | Network                                                                    | What leaves the machine                                                                                                                                                            |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scan`, `digest`, `context`, `trace`, `view`, `notes`, `install-skill` | none                                                                       | nothing                                                                                                                                                                            |
| `serve`                                                                | localhost only (127.0.0.1)                                                 | nothing; API needs a per-run token and matching Host/Origin                                                                                                                        |
| `research` (no flag)                                                   | none                                                                       | nothing; prints the exact requests it would make                                                                                                                                   |
| `research --online`                                                    | HTTPS to `registry.npmjs.org`, `pypi.org`, `api.osv.dev`, `endoflife.date` | public package names; to OSV also the version pinned in your lockfile (POST body); to endoflife.date only a product name (`nodejs`, `postgresql`…), the version is matched locally |
| `cost` (no flag)                                                       | none                                                                       | nothing; prints the price files it would download                                                                                                                                  |
| `cost --online`                                                        | HTTPS GET to `pricing.us-east-1.amazonaws.com`                             | the AWS service and region names in the URL path only                                                                                                                              |
| `cost --online --use-credentials`                                      | HTTPS POST to `api.pricing.us-east-1.amazonaws.com`, signed                | service, region and product filters; your AWS access key id as part of the signature                                                                                               |

Guarantees enforced in code and tests:

- Package names must look like registry identifiers (`isSafePackageName`) and versions like release
  identifiers (`isSafeVersion`); anything else is dropped, so code, paths, secrets or the repo name
  cannot be put into a query. endoflife.date product names come from a fixed table in BuildRAX.
- The fetcher only contacts hosts a provider declares, over HTTPS; other hosts are blocked.
- Responses are cached under `.buildrax/cache/` (git-ignored) for 24 hours.
- Notes are stored in `.buildrax/notes.json` (or browser storage in a static file). They are never
  read by `digest` or `context`, never sent by `research`, and there is no sync command.
- Scanning is static; repository code is never executed.
- The agent running a skill may itself send what you show it to its model provider. BuildRAX keeps
  what it shows the agent small (digest/context) and excludes notes.

## Optional cloud credentials (`cost --use-credentials`)

Off by default and used only for the run that passes the flag, together with `--online`.

- Read only from the environment (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, optional
  `AWS_SESSION_TOKEN`). BuildRAX never writes them anywhere: not the repo, `.buildrax/`, the cost
  report, caches or logs. `buildrax cost credentials status` reports only whether they are present.
- Sent only as a Signature V4 signature to the AWS Price List API host above; every other host is
  refused before any request, and redirects are refused.
- Removed from error messages before they are printed (the original error is dropped on purpose).
- Never passed to the agent skill or any model. The skill tells agents not to ask for keys in chat.
- Least privilege is enough: an IAM policy allowing only `pricing:GetProducts` (optionally
  `pricing:DescribeServices` and `pricing:GetAttributeValues`). Short-lived session credentials
  are preferred.

The public price files need no credentials at all; credentials only make lookups smaller.

## Prices you add

`.buildrax/prices.json` holds prices without a machine-readable source (Stripe fees, LLM tokens,
hosting plans…), written by you or by an agent you asked. Each entry needs a source URL and a
retrieval date; the file is validated and nothing in it is sent anywhere.

## Source code in the viewer

`buildrax view` embeds the source of scanned files into `.buildrax/view.html` so the Code tab works
offline (per file up to 300 KB, 8 MB total). That file is git-ignored and local, but **it contains
your source: do not share it unless you mean to**. Use `buildrax view --no-source` to leave source
out. `buildrax serve` embeds nothing; `/api/file` serves only files that are nodes of the scanned
model, only with the session token, and refuses anything outside the repo (including symlinks).
