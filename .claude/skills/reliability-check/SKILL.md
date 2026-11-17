---
name: reliability-check
description: Check a diff against OpenBots' reliability checklist, the list of things that have broken before, using only the items whose trigger matches the diff. Use before opening or updating a pull request, when reviewing one, and when asked whether a change is safe to merge.
---

# Check the diff against the reliability checklist

Nobody memorises past outages. The checklist does, and each item knows which diffs it applies to.

## 1. Get the items for this diff

```sh
node scripts/reliability-checklist.mjs                # this branch against origin/main
node scripts/reliability-checklist.mjs <base> <head>  # a pull request you are reviewing
```

It prints only the items triggered, usually a few of the full list, each with what triggered it, what to check and what is behind it. No item triggered is a real answer: say so and stop.

The Code Review service cannot run this script. It reads `REVIEW.md` instead, which states the same concerns in words, so a new item that a reviewer should also hold a change to needs a line there too.

When you are reviewing someone else's pull request, run the script from the default branch, not from the pull request's own checkout: a change must not be able to edit the list that judges it.

## 2. Do each check

For every item printed, do what its Check line says. Most are a command to run or a question the diff can answer. Read the Behind it line when the check is not obvious: it names the pull request, test or document that explains why the item exists.

An item is one of:

- **Holds**: say what you ran or read that shows it.
- **Does not hold**: fix it, or when reviewing, report it as Important with the item's id.
- **Does not apply**: the trigger matched but the change is not the kind the item is about. Say why in a few words. If that keeps happening for an item, its trigger is too wide: narrow it in a separate pull request.

## 3. Write it down

In the pull request's Reliability checklist section, list each id with its result:

```
- postgres-concurrency: holds, server tests pass on Postgres 16
- api-old-clients: does not apply, the route is new
```

## Changing the list

Add an item only for something that went wrong in at least one pull request and that a diff can show. `docs/VERIFICATION.md`, "Turning misses into rules", has the bar. The items live in `scripts/reliability-checklist.mjs`, and `apps/desktop/src/release/verification.test.ts` checks every item is well formed.
