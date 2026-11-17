# Privacy: what stays local and what is sent

| Feature                                                                | Network                                      | What leaves the machine                                     |
| ---------------------------------------------------------------------- | -------------------------------------------- | ----------------------------------------------------------- |
| `scan`, `digest`, `context`, `trace`, `view`, `notes`, `install-skill` | none                                         | nothing                                                     |
| `serve`                                                                | localhost only (127.0.0.1)                   | nothing; API needs a per-run token and matching Host/Origin |
| `research` (no flag)                                                   | none                                         | nothing; prints the exact requests it would make            |
| `research --online`                                                    | HTTPS to `registry.npmjs.org` and `pypi.org` | public package names in the URL path only                   |

Guarantees enforced in code and tests:

- Package names must look like registry identifiers (`isSafePackageName`); anything else is dropped,
  so code, paths, secrets or the repo name cannot be put into a query.
- The fetcher only contacts hosts a provider declares, over HTTPS; other hosts are blocked.
- Responses are cached under `.buildrax/cache/` (git-ignored) for 24 hours.
- Notes are stored in `.buildrax/notes.json` (or browser storage in a static file). They are never
  read by `digest` or `context`, never sent by `research`, and there is no sync command.
- Scanning is static; repository code is never executed.
- The agent running a skill may itself send what you show it to its model provider. BuildRAX keeps
  what it shows the agent small (digest/context) and excludes notes.

## Source code in the viewer

`buildrax view` embeds the source of scanned files into `.buildrax/view.html` so the Code tab works
offline (per file up to 300 KB, 8 MB total). That file is git-ignored and local, but **it contains
your source: do not share it unless you mean to**. Use `buildrax view --no-source` to leave source
out. `buildrax serve` embeds nothing; `/api/file` serves only files that are nodes of the scanned
model, only with the session token, and refuses anything outside the repo (including symlinks).
