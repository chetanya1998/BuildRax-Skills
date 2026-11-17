# Answering common questions

Always start from `buildrax scan` if `.buildrax/model.json` is missing or stale.

**"Show me the architecture."** `buildrax digest`, summarize packages and how they connect, then
offer `buildrax view --open`.

**"Where is X implemented / what does X talk to?"** `buildrax context "X"`, then
`buildrax trace X --direction down`. Cite the `file:line` anchors.

**"What breaks if I change X?"** `buildrax trace X --direction up`. List the affected files and
packages with the first-hop `file:line`. Mention that only static dependencies are covered.

**"Are there circular dependencies?"** `buildrax scan` lists them; confirm with
`buildrax trace` on one file in the cycle. Suggest where the cycle could be cut, as a proposal.

**"Is dependency Z up to date / deprecated?"** Run `buildrax research` and show the plan. After the
user agrees, `buildrax research --online`. Report version, date and source; say the registry shows
the latest release, not the pinned one.

**"What did I flag?"** `buildrax notes`. Read-only; quote them, do not change them.

**"How would this scale / what does it cost?"** BuildRAX does not measure runtime or price. Say so,
point to structural facts (cycles, hubs, fan-in) from the model, and ask for the missing inputs
(traffic, deployment, provider) instead of guessing.
