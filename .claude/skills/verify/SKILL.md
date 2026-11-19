---
name: verify
description: Verify a change to OpenBots by running it for real before committing. Use before every commit that changes behaviour, when asked to verify, test end to end, smoke test or "check it works", and before opening a pull request. Picks the right way to run the change from the paths it touched.
---

# Verify a change by running it

Tests passing is not the evidence. The evidence is the change running, with what you saw: output, a response, a screenshot. Do this before you commit.

## 1. Pick the surface from the diff

```sh
git diff --name-only $(git merge-base origin/main HEAD)
```

| The change touches                                                                                                                           | Use                                                                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `apps/web/`, `ee/web/`, `packages/ui`, `packages/widgets`                                                                                    | the verify skill in `apps/web`                                                            |
| `apps/server/`, `ee/server/`, `packages/agent`, `packages/router`, `packages/routines`, `packages/models`, `packages/mcp`, `packages/shared` | the verify skill in `apps/server` (and `apps/web` when a person would see the difference) |
| `apps/mobile/`                                                                                                                               | the verify skill in `apps/mobile`                                                         |
| `apps/desktop/`                                                                                                                              | the verify skill in `apps/desktop`                                                        |
| `apps/relay/`, `packages/tunnel`                                                                                                             | the verify skill in `apps/relay`                                                          |
| `docker/`, `compose.yaml`, `install.sh`, `scripts/backup.sh`, `scripts/restore.sh`, `packages/computer`, `apps/computer-agent`               | the verify skill in `docker`                                                              |
| only `*.md` or `docs/`                                                                                                                       | nothing to run: `Verified: none: docs only`                                               |
| only tests, scripts or CI                                                                                                                    | run what you changed, once, and show its output                                           |

Each is a `SKILL.md` under that directory's `.claude/skills/verify/`. Read it and follow it. A change across several surfaces runs each one.

## 2. Boot once, drive the flow you changed

Most surfaces start from the same stack:

```sh
bash scripts/verify-stack.sh start            # self-hosted, about 10 seconds
bash scripts/verify-stack.sh start --managed  # several users can sign up
bash scripts/verify-stack.sh stop
```

It gives a fresh database every time, the server from source on :3000, the web app on :5173 and logs in `.verify/`. Then do what a person would do to see your change, and one thing next to it that must not have changed.

## 3. If it fails

Fix the cause and run it again. Three rounds. If it still fails, stop and tell the person what fails, what you tried and what you think the cause is. Never skip a spec, add a wait or a retry, or loosen an assertion to get through.

## 4. Record it

End the commit message with one trailer, and say in the pull request's Verification section what you ran and saw:

```
Verified: verify            the change, running (this skill)
Verified: e2e               the browser or device specs for the flow
Verified: tests-only        unit, property or differential tests only
Verified: none: <reason>    not verified, and why
```

If part of the change could not be run here (no Docker daemon, no simulator, no Mac), say exactly which part and stamp what you did run. Do not claim the rest.

## Keeping this skill good

This is the smoke test harness, so it has to be fast and it has to be right. When a step here is slow, flaky or out of date, fix the skill or `scripts/verify-stack.sh` in the same pull request and say so.
