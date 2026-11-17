---
name: verify
description: Verify a change to the OpenBots server or the packages it runs (apps/server, ee/server, packages/agent, router, routines, models, mcp, shared) against a running server and a real Postgres. Use before committing any server-side change, and when asked to check an API route, a run, a worker, a migration or a query.
---

# Verify a server change

## Boot and call it

```sh
bash scripts/verify-stack.sh start    # from the repository root; add --managed for organizations
curl -fsS http://localhost:3000/readyz
```

The stack is the server from source on real Postgres and Redis, with a fresh database, so the migrations have just run from nothing. Now make the request your change is about and read the answer:

```sh
# The first user of a self-hosted install is its owner.
curl -sS -c .verify/cookies -H 'content-type: application/json' -H 'origin: http://localhost:3000' \
  -d '{"name":"Verify","email":"verify@example.com","password":"correct horse battery"}' \
  http://localhost:3000/api/v1/setup/admin
curl -sS -b .verify/cookies http://localhost:3000/api/v1/bots
```

`packages/api-client/openapi.json` lists every route and its shape. `.verify/server.log` is the server's log: read it after your request, and expect no new warning or error.

A change to a run, a tool, a Routine or anything a Bot does is easiest to drive through the browser specs, which script the model's replies (`apps/web/e2e/fake-model.ts`): use the verify skill in `apps/web` and pick the spec for the flow.

## What a running server shows that the unit tests do not

- **Queries, transactions, workers.** The unit tests run on PGlite, one query at a time. Run them on the real server too:

  ```sh
  DATABASE_URL=postgres://openbots:openbots@127.0.0.1:5432/openbots \
    pnpm turbo run test --filter @openbots/server
  ```

  This also runs `src/db/differential.test.ts`, which compares PGlite with Postgres.

- **Migrations.** Starting the stack applied them to an empty database. For a migration that changes existing data, also check it against rows: `apps/server/src/db/migrations.test.ts` shows how to migrate a database forward from an earlier state.
- **Routes.** Regenerate the OpenAPI document and client, then check that an installed app still works:

  ```sh
  pnpm --filter @openbots/server openapi
  pnpm exec prettier --write packages/api-client/openapi.json
  pnpm --filter @openbots/api-client generate
  git show origin/main:packages/api-client/openapi.json > .verify/openapi.base.json
  node scripts/openapi-diff.mjs .verify/openapi.base.json packages/api-client/openapi.json
  ```

- **Settings.** Start the stack once without the new variable set: an install that does not know about it must behave as before.

## Finish

```sh
bash scripts/verify-stack.sh stop
```

Stamp the commit `Verified: verify` when you called what you changed on the running server.
