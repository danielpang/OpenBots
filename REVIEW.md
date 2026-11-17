# Reviewing a change to OpenBots

What a reviewer, human or agent, pays attention to in this repository. A review reads this file from the default branch, never from the pull request it is reviewing, and reviews one commit: a push during the review makes its result out of date, so review again.

## First

1. Run `node scripts/reliability-checklist.mjs <base> <head>` and check each item it prints against the diff. Report an item only when the diff gets it wrong, with the item's id.
2. Read how the change was verified: the `Verified:` trailer on its commits and the pull request's Verification section. `tests-only` or `none` on a change to behaviour a person can see is worth a comment. Ask for the evidence, not for more tests.
3. If earlier rounds of review exist on this pull request, start from them: check that each finding was fixed, then look only at what changed since. Do not review from nothing again.

## What matters most here

In this order. A finding in an earlier group outweighs any number in a later one.

1. **One organization or user reaching another's data.** Every table with an organization's data is behind row-level security, and every route checks ownership. A new query that does not go through the scoped database handle is a finding.
2. **Data treated as instructions.** What a webhook, another Bot, a fetched page or a file says is data (PRD P2). Nothing it contains may loosen a tool's policy, pick a recipient or reach a shell unescaped.
3. **Bot computers escaping their sandbox.** Anything that widens what the docker guard allows, what the sandbox firewall lets through, or what a stdio MCP server can read.
4. **Secrets leaving the server.** In a log line, an error message, an API response, a prompt or a commit.
5. **A released app breaking.** The iOS and Mac apps and paired relays are older than the server they talk to. A removed field, a new required input or a changed protocol frame is a finding unless the change records why it is safe.
6. **Stored data that no longer loads.** Message parts, settings and migrations must read rows written before the change.
7. **Races.** A check followed by a write, without a transaction, a lock or a unique constraint, is a finding in server code even when the tests pass: they run on PGlite, one query at a time.
8. **Correctness of the change itself**, then missing tests for behaviour that changed.

Do not report: formatting (prettier decides), import order, naming preferences, or a refactor the change did not ask for.

## How to report

- Label each finding **Important** (fix before merging), **Nit** (the author decides) or **Pre-existing** (true, but not caused by this change, so not this author's to fix here).
- Say what input or state makes it go wrong and what happens then. A finding without a failure scenario is a guess: verify it or leave it out.
- When a finding asks for a person to look, say why in one sentence, so they do not have to work it out from the diff.
- If the change edits a check (this file, `CLAUDE.md`, `.claude/`, `.github/`, the gate scripts, an approved-changes list), say what the check allowed before and allows now. A change that loosens the check that judges it is Important.

## Area notes

Owners add to these when a review misses something they would have flagged (docs/VERIFICATION.md, "Turning misses into rules"). Keep each to what a diff can show.

- **`apps/server/src/db`, `apps/server/drizzle`**: never edit a migration that has shipped. New columns are nullable or defaulted.
- **`packages/agent/src/policy`, `packages/shared/src/policy.ts`**: a trigger override only raises a decision. Look up a tool by name with `ownEntry`, never a plain index.
- **`packages/agent/src/context`, `packages/agent/src/run`**: every tool result follows its call after pruning or a resume, and nothing that changes per turn sits before a cache breakpoint.
- **`packages/router`**: every new way to start a run goes through `withinChainLimits`.
- **`apps/relay`, `packages/tunnel`**: a version 1 client must still be able to read every frame. The protocol document changes in the same pull request.
- **`docker/`, `packages/computer`**: the hardening steps in `docs/plans/RELEASE_CHECKS.md` that the change touches were run on a Docker host, and the pull request says so.
- **`ee/`**: nothing under `apps/` or `packages/` imports from it.
