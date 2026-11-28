# Narrative

## Product
BuildRAX Skills: scans a repo locally and turns it into an evidence-backed architecture map (packages, imports, endpoints, databases, queues, paid services, each with a file:line), viewable offline and readable by coding agents as a compact summary.

## Audience
Indie hackers and solo technical founders, developers inheriting codebases, vibe-coders building with AI, context engineers, and teams who want the architecture map in CI.

## Problem
"I don't know how this codebase is really wired together" — and agents burn tokens crawling source to find out. Static, local, no LLM, no upload.

## Origin
I watched my own team struggle because nobody had the whole picture of the system. Without it:
- troubleshooting took far too long;
- technical bottlenecks were hard to find and fix once the system was in production;
- no one could say what our APIs and infrastructure would actually cost;
- it was hard to know how, and where, the system would break as it scaled;
- security risks that could hurt the system stayed hidden.
BuildRAX is the tool I wanted for them: one evidence-backed view of the whole system (architecture, flows, cost by traffic tier, advisories and end-of-life runtimes), built straight from the code.

## Stage
prototype — works end to end, 266 tests, CI on Node 22/24; no npm release yet, package names are placeholders.

## Milestones
- [ ] First npm release

## Voice
Founder and product manager of BuildRAX. Problem → solution: open with a real developer pain, show how BuildRAX solves it with a concrete detail from the day's work. Inspiring for developers and solo founders: honest, builder-to-builder, no hype words.

## Platforms
X, LinkedIn

## Off-limits
Secrets, credentials and internal URLs (none to share yet; add more as needed).

## Arc so far
- 2026-11-28: started building BuildRAX in public.
