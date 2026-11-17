---
name: tidy-checks
description: Review and prune OpenBots' own checks: turn missed bugs into checklist items or review rules, and remove rules, checklist items and tests that no longer earn their place. Use for the monthly "Verification review" issue, after a revert or an incident, and when asked to tidy, prune or audit CLAUDE.md, REVIEW.md, the reliability checklist, the verify skills or flaky tests.
---

# Tidy the checks

Test suites, verification steps and rule files only grow unless someone prunes them. This is that someone. Work in a pull request of its own, so the change to the checks is reviewed as one.

## 1. Get the numbers

```sh
node scripts/verification-stamps.mjs report --days 30
```

It prints how commits on the default branch were verified, the reverts and quick follow-up fixes in the period, and how large each rule file has grown. The monthly issue has the same report.

## 2. Turn misses into rules

For each revert or follow-up fix in the report, and each thing a person had to point out in review that the checks did not:

1. Could a diff have shown it? If not, it is not a rule. Consider a test instead.
2. Has it happened in at least two pull requests? Once is an anecdote. Note it in the issue and move on.
3. Try to disprove it. Find three merged, healthy changes that the proposed trigger would also have matched. If it would have flagged them, the trigger is too wide or the rule is wrong.
4. If it survives, add it where it will be read: an item in `scripts/reliability-checklist.mjs` when a path or a line pattern can trigger it, else one line under the right area in `REVIEW.md`. Cite the pull requests behind it.

Then replay: check out the commit before the fix and run `node scripts/reliability-checklist.mjs <before>~1 <before>`. The new item must be printed for the change that caused the bug.

## 3. Prune

Remove, do not comment out:

- a checklist item whose mistake a test or a type now makes impossible (say which, in the commit)
- an item or rule that has not matched or been cited in months, or that people answer "does not apply" every time
- two rules that say the same thing: keep the more specific one
- a line in `CLAUDE.md` that restates something the cheap checks already enforce
- a test that cannot fail, or that only repeats another

## 4. Flaky tests

Find them in the CI history (a job that failed and passed on a rerun of the same commit). For each: find the root cause and fix it. No skip, no sleep, no retry, no longer timeout. If the cause cannot be found, delete the test and write in the commit what it covered and why it was removed, so the gap is known rather than hidden.

## 5. Keep the verify skills honest

Run each verify skill's commands once, as written. Fix any that fail or have drifted from the code, and time `bash scripts/verify-stack.sh start`: if it has become slow, find out why. A slow smoke test stops being run.

## 6. The gates

Read `.verify/commit-gate.log` if there is one, and the stamp notices in recent CI runs. If an observe-mode gate has had no false positive for a month, propose moving it to enforce (`OPENBOTS_COMMIT_GATE` in `.claude/settings.json`, `VERIFICATION_STAMPS` and `API_DIFF` in `.github/workflows/ci.yml`). If it has blocked honest work, fix the gate first.

Close the issue with what you added, what you removed and what you left, each with a reason.
