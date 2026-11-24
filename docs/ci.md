# Architecture map in CI

The recommended team setup: **keep `.buildrax/` out of git** and let CI build the map for every
push and pull request. Scanning is static (nothing in the repository is executed), deterministic
and fast, so the map always matches the commit and there are no generated-file merge conflicts.

Each run:

1. scans the checkout (`buildrax scan`);
2. writes what changed since the base branch (pull requests) or the previous push to the job
   summary (`buildrax diff --since <base> --markdown`);
3. uploads `model.json`, the offline viewer `view.html` and `diff.md` as a build artifact.

This repository runs the same recipe on itself: see the `architecture` job in
`.github/workflows/ci.yml`.

## Recipe (GitHub Actions)

> Package names are placeholders until BuildRAX is published; until then build it from this
> repository and call `node <path>/packages/cli/dist/bin.js` instead of `npx buildrax`.

```yaml
name: Architecture
on:
  pull_request:
  push:
    branches: [main]
permissions:
  contents: read
jobs:
  map:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0 # needed to scan the base commit for the diff
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npx buildrax scan .
      - name: What changed
        env:
          BASE: ${{ github.event_name == 'pull_request' && format('origin/{0}', github.base_ref) || github.event.before }}
        run: |
          if [ -n "$BASE" ] && git rev-parse --verify --quiet "$BASE^{commit}" >/dev/null; then
            npx buildrax diff . --since "$BASE" --markdown > .buildrax/diff.md
          else
            echo "No base commit to compare with." > .buildrax/diff.md
          fi
          cat .buildrax/diff.md >> "$GITHUB_STEP_SUMMARY"
      - run: npx buildrax view .
      - uses: actions/upload-artifact@v4
        with:
          name: buildrax-architecture
          path: |
            .buildrax/model.json
            .buildrax/view.html
            .buildrax/diff.md
          retention-days: 30
```

Notes:

- The base ref is passed through an environment variable, never interpolated into the script.
- `buildrax diff --since` exports the base commit with `git archive` into a temporary folder and
  scans it there; the checkout is not modified. Unchanged files reuse the parse cache.
- **`view.html` contains your source code** (for the Code tab). The artifact is visible to anyone
  who can see the workflow run, which for a private repository is the people who can already read
  the code. Use `buildrax view . --no-source` if that is not the case (for example public
  repositories that build artifacts from forks).
- To open the map: download the artifact, unzip, open `view.html` in a browser (works offline).

## Optional: block new circular dependencies

```yaml
- run: npx buildrax diff . --since "origin/${{ github.base_ref }}" --fail-on-new-cycles
```

The step fails only when the pull request **introduces** a cycle; existing ones do not fail it.

## Optional: post the diff as a pull-request comment

Needs write access to pull requests, so keep it in a separate job that only reads `diff.md`:

```yaml
comment:
  needs: map
  if: github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository
  runs-on: ubuntu-latest
  permissions:
    pull-requests: write
  steps:
    - uses: actions/download-artifact@v4
      with:
        name: buildrax-architecture
    - env:
        GH_TOKEN: ${{ github.token }}
        PR: ${{ github.event.pull_request.number }}
      run: gh pr comment "$PR" --repo "$GITHUB_REPOSITORY" --body-file diff.md --edit-last --create-if-none
```

The `if:` skips pull requests from forks, whose workflows cannot get write tokens anyway.
`--edit-last` keeps one comment per pull request instead of adding a new one on every push.
The Markdown escapes repository text (paths, names), so file names cannot inject markup.

## Teams that prefer committing the model

Possible but not recommended: the file (about 250 KB for a mid-size repo) changes on every
structural change and conflicts between parallel branches (resolve by rescanning). If you do, add a
CI check that runs `buildrax scan` and fails on `git diff --exit-code .buildrax/model.json`.
