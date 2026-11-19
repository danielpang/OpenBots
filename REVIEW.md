# Review instructions

## What Important means here

Reserve Important for findings that would let one organization or user reach
another's data, treat data as instructions, weaken the isolation of a Bot's
computer, leak a secret, break an app that is already installed, stop stored
data from loading, or lose a write to a race. Incorrect logic in the change
itself is Important when it breaks behaviour a person would notice. Style,
naming, refactoring suggestions and missing tests for unchanged behaviour are
Nit at most.

A change that loosens a check that judges it is Important: `REVIEW.md` files,
`CLAUDE.md`, `.claude/`, `.github/`, the gate scripts in `scripts/` and
`packages/api-client/openapi-approved-changes.json`.

## Cap the nits

Report at most five Nits per review.

## Do not report

- Anything CI already enforces: formatting, lint, type errors, a stale OpenAPI
  document or generated client, licenses
- Generated files: `packages/api-client/openapi.json`,
  `packages/api-client/src/schema.ts`, `ee/server/openapi.json`,
  `ee/web/src/schema.ts`, `apps/web/src/routeTree.gen.ts`,
  `apps/mobile/src/preview/generated.ts`, and `pnpm-lock.yaml`
- Test-only code that intentionally breaks production rules, such as a fixed
  secret or an unscoped query in a test helper
- Import order, naming preferences, or a refactor the change did not ask for
- In `docs/plans/`, anything but a statement that contradicts the code

## Require evidence

- A claim about behaviour needs a `file:line` citation in the source, not an
  inference from a name
- A finding says what input or state makes it go wrong and what happens then.
  Leave out a finding that has no failure scenario
- A race needs the two interleaved steps named. "This might race" is not a
  finding

## Always check

- Database queries are scoped to the caller's organization, and a new route
  checks that the caller owns what it reads or changes
- Text from a webhook, another Bot, a fetched page or a file is used as data.
  It never chooses a tool's policy, a recipient or a shell command
- Log lines and error messages do not include secrets, tokens, connector
  settings, request headers or message text
- A changed API route still answers a client built before the change: no
  removed operation or response field, no new required input, unless
  `packages/api-client/openapi-approved-changes.json` records why
- A changed schema in `packages/shared/src/` still reads rows written before
  the change: new fields are optional or defaulted
- A check followed by a write is inside a transaction, behind a lock or backed
  by a unique constraint. The tests run on PGlite, one query at a time, so
  passing tests do not show this
- A new setting is in `.env.example` and `docs/SELF_HOSTING.md`, and an install
  that does not set it behaves as before
- Nothing under `apps/` or `packages/` imports from `ee/`
- User-facing text and docs have no em or en dash and no hyphen used as a pause
- The pull request says how the change was verified. `tests-only` or `none` on
  a change to behaviour a person can see is a Nit asking for the evidence
