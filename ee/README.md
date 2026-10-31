# ee: OpenBots Enterprise Edition

Code for the managed OpenBots service lives here: organizations and admin
features, and later billing and Stripe, and anything else that is not part
of self-hosted OpenBots.

Everything in this directory is proprietary and covered by
[ee/LICENSE](LICENSE). The rest of the repository is under the Business Source
License in the root [LICENSE](../LICENSE).

Rules for code here:

- The core (`apps/`, `packages/`) never imports from `ee/`. Enterprise code
  plugs into the core through its extension points, so self-hosted OpenBots
  builds and runs without this directory. `node scripts/check-licenses.mjs`
  checks both.
- Enterprise code runs only when `OPENBOT_DEPLOYMENT=managed`.
- Each package is private, says `"license": "SEE LICENSE IN LICENSE"`, and
  keeps a copy of `ee/LICENSE` beside its `package.json`.

## Packages

- `server` (`@openbot/ee-server`): the managed server. `src/main.ts` runs the
  core server (`runServer` from `@openbot/server/server`) with organizations:
  better-auth's organization plugin on the core's tables, roles, invitations,
  email verification and invite email through Resend, and the
  `/api/v1/organizations`, `/api/v1/organization` and `/api/v1/invitations`
  routes. Its image is `server/Dockerfile`.
- `web` (`@openbot/ee-web`): the managed web app. `src/main.tsx` starts the
  core web app (`startWeb` from `@openbot/web/start`) with onboarding, the
  organization switcher and the organization's settings.

See section 21 of [docs/TECHNICAL_PLAN.md](../docs/TECHNICAL_PLAN.md).

## Running it

```sh
pnpm build
OPENBOT_DEPLOYMENT=managed OPENBOT_SIGNUP_MODE=open OPENBOT_DEV_LOG_EMAIL_LINKS=1 \
  node ee/server/dist/main.js
```

Without `RESEND_API_KEY` and `OPENBOT_EMAIL_FROM` no email is sent: invite
links are there to copy, and with `OPENBOT_DEV_LOG_EMAIL_LINKS=1` (never in
production) the email verification link is in the server's log. For the web
app with hot reload, `pnpm --filter @openbot/ee-web dev` proxies to the
server on :3000.

After changing a route, regenerate the document and the web types:

```sh
pnpm --filter @openbot/ee-server openapi
pnpm exec prettier --write ee/server/openapi.json
pnpm --filter @openbot/ee-web generate
```
