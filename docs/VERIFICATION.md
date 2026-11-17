# Verification

How a change to OpenBots is shown to work, what checks it, and when each check runs. Most changes here are written by coding agents, so the checks are what lets a person review evidence instead of reading every diff.

[CLAUDE.md](../CLAUDE.md) is the short form an agent reads. [REVIEW.md](../REVIEW.md) is what a reviewer looks for. This page is the reasoning and the reference.

## What runs when

| When                                   | What runs                                                                                                                           | Where it lives                                                              | If it fails                                                     |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------- |
| An agent finishes a turn               | Cheap checks: format, then types, lint and tests for the packages that changed, and the OpenAPI document when a route changed       | `scripts/agent-checks.mjs`, the Stop hook in `.claude/settings.json`        | Sent back to the agent, three rounds, then handed to the person |
| Before a commit                        | The `verify` skill for what changed: the app, running                                                                               | `.claude/skills/verify`, and one beside each app                            | Fix and run again, three rounds, then stop and ask              |
| At the commit                          | Commit gate: is there a `Verified:` trailer, and did the session do what it claims                                                  | `scripts/agent-commit-gate.mjs`, the PreToolUse hook                        | Observe mode logs. Enforce mode blocks, at most twice a session |
| Before a pull request                  | Reliability checklist, only the items the diff triggers                                                                             | `scripts/reliability-checklist.mjs`, the `reliability-check` skill          | Fix, or say why the item does not apply                         |
| On every pull request                  | Verification gates job: checklist summary, stamps, API diff against the base branch, a flag when the checks themselves changed      | `gates` in `.github/workflows/ci.yml`                                       | Observe mode warns. Enforce mode fails `CI result`              |
| On every pull request and push to main | Unit, property and differential tests, real Postgres, browser specs, image and lifecycle smoke tests, selected by changed paths     | `.github/workflows/ci.yml`, `scripts/ci-scope.mjs`                          | Fails `CI result`                                               |
| At review                              | Code Review reads `REVIEW.md` (the root one, and the one beside the changed code) and `CLAUDE.md` from the protected default branch | `REVIEW.md`, `apps/*/REVIEW.md`, `packages/*/REVIEW.md`, `docker/REVIEW.md` | Findings marked Important, Nit or Pre-existing                  |
| Monthly, and after a revert            | Review of the checks: stamps, misses, size of the rules                                                                             | `.github/workflows/verification-review.yml`, the `tidy-checks` skill        | An issue to work through                                        |

The order is deliberate. Cheap checks run first and locally, so a mistake an agent could have caught does not spend shared CI time or a reviewer's attention.

## Verifying means running the change

A unit test can pass while the feature is broken, because neither the test nor its author saw the whole task. So the main check is a `verify` skill that boots the real app and drives the flow that changed. There is one beside each thing that ships:

| Skill                                | Runs                                                                            |
| ------------------------------------ | ------------------------------------------------------------------------------- |
| `apps/web/.claude/skills/verify`     | The web app in a browser, against a running server, with Playwright             |
| `apps/server/.claude/skills/verify`  | The server from source on real Postgres, called over HTTP                       |
| `apps/mobile/.claude/skills/verify`  | The iOS app in a simulator (a Mac), or the bundle and component tests elsewhere |
| `apps/desktop/.claude/skills/verify` | The Mac app (a Mac), or its build and tests elsewhere                           |
| `apps/relay/.claude/skills/verify`   | The relay, with a client connected                                              |
| `docker/.claude/skills/verify`       | The images and the compose stack (a Docker host)                                |
| `.claude/skills/verify`              | Picks among them from the diff                                                  |

`bash scripts/verify-stack.sh start` is what most of them boot: a fresh database, the server on :3000 and the web app on :5173, in about ten seconds. Keep it that fast. A slow smoke test stops being run.

Some surfaces cannot run everywhere. A skill says which level was reached, and the stamp records it. Nobody claims a simulator run from a machine without a simulator.

## Three kinds of test worth writing

- **End to end** (`apps/web/e2e`, `apps/mobile/maestro`): a real user flow. Hard to fool, and when it fails it shows what a person would see.
- **Property** (`*.property.test.ts`, with fast-check): a statement that must hold for every input, checked against thousands of generated ones. Round trips, invariants, idempotency, and "never looser than". They find the cases nobody thought of: the first ones here found a Skill slug that kept a capital letter, and a policy lookup that reached properties every object inherits.
- **Differential** (`apps/server/src/db/differential.test.ts`, `scripts/openapi-diff.mjs`): two systems that should agree, given the same input. PGlite against real Postgres, and this change's API against the base branch's. A difference is a bug, or goes on a short list of approved differences with its reason.

A slow or flaky test teaches an agent to run it again instead of fixing the code. A flaky test is fixed at its root or deleted with a note saying what it covered. It is never skipped, slept past or retried.

## The stamp

Every commit ends with how it was verified:

```
Verified: verify            a verify skill: the change, running
Verified: e2e               the browser or device specs for the flow
Verified: tests-only        unit, property or differential tests only
Verified: none: <reason>    not verified, and why
```

`none` is a valid answer, and that is the point: unverified commits can be counted instead of guessed at. The pull request template has the same line, because a squash merge keeps the description, not the commits.

```sh
git log --format='%h %(trailers:key=Verified,valueonly,separator=%x20) %s' origin/main
node scripts/verification-stamps.mjs report --days 30
```

## Failing checks need a person

An agent fixes what fails. If the same check still fails after three rounds, it stops and says what fails, what it tried and what it thinks the cause is. The Stop hook counts the rounds, and after the third lets the turn end with a note for the person. Failures are one way to decide what needs a human, since nobody can read every change.

## New gates start in observe mode

A gate that is wrong blocks honest work, so each one has three modes:

- **off**: does nothing
- **observe**: never blocks, and logs what it would have blocked
- **enforce**: blocks

| Gate                    | Setting                                           | Starts as                                |
| ----------------------- | ------------------------------------------------- | ---------------------------------------- |
| Commit gate             | `OPENBOTS_COMMIT_GATE` in `.claude/settings.json` | observe (log: `.verify/commit-gate.log`) |
| Stamps on pull requests | `VERIFICATION_STAMPS` in the `gates` job          | observe                                  |
| API diff                | `API_DIFF` in the `gates` job                     | observe                                  |

Move a gate to enforce when its log has shown no false positive for about a month. In enforce mode the commit gate blocks a session at most twice, then lets the next commit through and says so: an agent must never be stuck behind a gate that is wrong. A commit that cannot be verified still commits, with `Verified: none: <reason>`.

## What a review reads

`REVIEW.md` follows the shape Code Review documents for it ([Customize Code Review](https://code.claude.com/docs/en/code-review-customize)): what Important means here, a cap on Nits, what not to report, the evidence a finding needs, and what to always check. It holds instructions that change a review and nothing else. Project context lives in `CLAUDE.md`.

- The root `REVIEW.md` applies to every pull request.
- A `REVIEW.md` beside an area's code (`apps/server`, `apps/relay`, `apps/mobile`, `packages/agent`, `packages/router`, `packages/tunnel`, `packages/computer`, `docker`) adds checks when a pull request changes files under it. This is the review's own diff trigger.
- `CLAUDE.md` is read by the review service and by the local `/code-review` command. The local command does not read `REVIEW.md`, so a rule that both must hold a change to goes in `CLAUDE.md`.
- A review cannot run a script. What the reliability checklist checks by script, `REVIEW.md` states in words.

The service reads these files from the base or default branch, never from the pull request. It honours lowered severities, exclusions, the Nit cap and the files beside the code only when that branch is protected.

## Protected checks

If a change can edit the check that judges it, the check is worth nothing. So:

- The `gates` job takes its scripts and the base API document from the base branch, not from the pull request.
- A review reads `REVIEW.md` from the default branch, never from the pull request, and reviews one commit. A push during the review makes the result out of date.
- `.github/CODEOWNERS` names every check as needing an owner's review: every `REVIEW.md`, `CLAUDE.md`, `.claude/`, `.github/`, the gate scripts and the approved-changes list. The `gates` job warns when a pull request touches any of them.

One thing the repository cannot do for itself: `main` has to be protected on GitHub. Without that, Code Review reads only the root `REVIEW.md` and ignores its exclusions and Nit cap, CODEOWNERS does not bind (it also needs review from code owners required), and `CI result` does not gate a merge unless it is a required check.

## Turning misses into rules

When something gets past the checks, the lesson is written down once, where the next change will meet it.

1. **From review and reverts.** A pattern is a candidate rule when it has shown up in at least two pull requests and a diff can show it. Try to disprove it against merged, healthy changes: if the rule would have flagged them too, it is wrong or too wide. What survives becomes an item in `scripts/reliability-checklist.mjs` (when a path or a line can trigger it) or a line under Always check in the `REVIEW.md` beside that area's code, in a pull request an owner approves.
2. **From incidents.** Check out the commit before the fix and run the checklist and a review on the change that caused it. If they miss a bug that is visible in a small diff, that gap is the rule to write.

The people who own an area write its rules, and refine them until they flag what the owner would flag.

## Pruning

Tests, checklist items and rule files only grow unless someone removes things. On the first of each month a workflow opens a "Verification review" issue with the numbers, and the `tidy-checks` skill works through it: misses become rules, and rules that no longer earn their place are deleted. An item goes when a test or a type makes its mistake impossible, when it has not matched in months, or when it duplicates another.

## How to tell the checks are working

The measures that matter are outcomes, not counts of tests:

- merged changes that were reverted, or fixed within two weeks in the same file (the monthly report lists them)
- what share of commits carry `verify` or `e2e`, against `tests-only` and `none`
- findings a reviewer raised that a check could have raised first
