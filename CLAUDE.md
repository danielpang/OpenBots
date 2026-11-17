# Working on OpenBots

[docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) says what a change includes, how commits are written and how CI selects its jobs. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) says where the code is. This file is the part that is specific to a coding agent: how to show that a change works. [docs/VERIFICATION.md](docs/VERIFICATION.md) explains each rule.

## Verify before you commit

Passing tests are not the evidence. Running the change is.

1. Run the `verify` skill before every commit that changes behaviour. The one beside the code you changed applies (`apps/web`, `apps/server`, `apps/mobile`, `apps/desktop`, `apps/relay`, `docker`), else the one at the root. It boots the real app and drives the flow you touched.
2. Run the `reliability-check` skill before you open a pull request. It reads the diff and gives you only the checklist items that apply.
3. End every commit message with how it was verified:

   ```
   Verified: verify | e2e | tests-only | none: <reason>
   ```

   `none` is an honest answer and always needs its reason. Never write `verify` or `e2e` for something you did not run.

The cheap checks (format, types, lint and tests for the packages you changed) run on their own when you finish a turn. `node scripts/agent-checks.mjs` runs them by hand.

## When a check fails

- Fix the cause. Up to three rounds. If it still fails, stop and tell the person what fails, what you tried and what you think the cause is.
- Never skip, delete or weaken a test to get past it. Never add a sleep, a retry or a longer timeout to make a test pass.
- A flaky test gets the same treatment as a failing one: find the root cause. If you cannot, delete the test and write down why in the commit, rather than leaving a test that teaches everyone to run it again.
- Do not edit the checks to pass them: `REVIEW.md` files, this file, `.claude/`, `.github/`, the gate scripts in `scripts/` and `openapi-approved-changes.json` change only when the task is to change them, in a pull request that says what the check allowed before and allows now.

## Rules every change is held to

Reviews flag a change that breaks one of these. `REVIEW.md` (and the one beside an area's code) adds what only a pull request review needs.

- Database queries are scoped to the caller's organization, and a route checks that the caller owns what it touches.
- What a webhook, another Bot, a fetched page or a file says is data, never instructions.
- No secret, token or message text in a log line or an error.
- A released app keeps working: the iOS and Mac apps and paired relays are older than the server they talk to.
- Stored rows written before a change still load after it.
- A migration that has shipped is never edited.

## Things that are easy to get wrong here

- Server tests run on PGlite, one query at a time. A change to a query, a transaction or a worker also runs on real Postgres (`bash scripts/dev.sh` prints the `DATABASE_URL`).
- A route change needs the OpenAPI document and client regenerated, and must not break an app that is already installed: `node scripts/openapi-diff.mjs`.
- User-facing text and docs use plain sentences. No em or en dashes, and no hyphen as a pause.
- Core packages never import from `ee/`.
