# ee: OpenBots Enterprise Edition

Code for the managed OpenBots service lives here: organizations and admin
features, billing through Stripe, and anything else that is not part of
self-hosted OpenBots.

Everything in this directory is proprietary and covered by
[ee/LICENSE](LICENSE). The core is under the Apache License 2.0
in the root [LICENSE](../LICENSE). The mobile app is proprietary and
source-visible under [apps/mobile/LICENSE](../apps/mobile/LICENSE).

Rules for code here:

- Nothing in `apps/` or `packages/`, the mobile app included, imports from `ee/`. Enterprise code
  plugs into the core through its extension points, so self-hosted OpenBots
  builds and runs without this directory. `node scripts/check-licenses.mjs`
  checks both.
- Enterprise code runs only when `OPENBOTS_DEPLOYMENT=managed`.
- Each package is private, says `"license": "SEE LICENSE IN LICENSE"`, and
  keeps a copy of `ee/LICENSE` beside its `package.json`.

## Packages

- `server` (`@openbots/ee-server`): the managed server. `src/main.ts` runs the
  core server (`runServer` from `@openbots/server/server`) with organizations:
  better-auth's organization plugin on the core's tables, roles, invitations,
  email verification and invite email through Resend, and the
  `/api/v1/organizations`, `/api/v1/organization` and `/api/v1/invitations`
  routes, and billing (`src/billing/`: plans, computer hours, spending
  limits, Stripe, the `/api/v1/billing` routes). Its image is
  `server/Dockerfile`.
- `web` (`@openbots/ee-web`): the managed web app. `src/main.tsx` starts the
  core web app (`startWeb` from `@openbots/web/start`) with onboarding, the
  organization switcher and the organization's settings, Billing included.

See section 21 of [docs/plans/TECHNICAL_PLAN.md](../docs/plans/TECHNICAL_PLAN.md).

## Running it

```sh
pnpm build
OPENBOTS_DEPLOYMENT=managed OPENBOTS_SIGNUP_MODE=open OPENBOTS_DEV_LOG_EMAIL_LINKS=1 \
  node ee/server/dist/main.js
```

Without `RESEND_API_KEY` and `OPENBOTS_EMAIL_FROM` no email is sent: invite
links are there to copy, and with `OPENBOTS_DEV_LOG_EMAIL_LINKS=1` (never in
production) the 6-digit email verification code is in the server's log. For the web
app with hot reload, `pnpm --filter @openbots/ee-web dev` proxies to the
server on :3000.

## Billing

Plans, the computer hour allowance, overage and the spending limits are in
`server/src/billing/`, and section 21.10 of the technical plan says how they
work. Pro is $20 a seat a month, Team $18 a seat with two seats at least, and
a first checkout starts a 14 day trial with a card that stops at 20 computer
hours. Each seat brings 100 computer hours a period; past them work stops,
unless an owner or admin allows overage at $0.20 an hour under a spending
limit (by default the monthly seat total).

| Variable                                | Default                   | What                                                                                                                                                    |
| --------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `STRIPE_SECRET_KEY`                     | none                      | Stripe's API key. Without it plans, limits and the ledger still work from the database, no overage is reported, and checkout and the portal answer 503. |
| `STRIPE_WEBHOOK_SECRET`                 | none                      | Verifies `POST /api/v1/billing/webhook`. Without it the webhook answers 503.                                                                            |
| `STRIPE_PRICE_PRO`, `STRIPE_PRICE_TEAM` | none                      | The seat prices.                                                                                                                                        |
| `STRIPE_PRICE_OVERAGE`                  | none                      | The metered price for computer hours past the allowance, on the meter both plans share. Without it no overage is reported.                              |
| `STRIPE_METER_EVENT`                    | `openbots_computer_hours` | That meter's event name.                                                                                                                                |
| `OPENBOTS_BILLING`                      | `on`                      | `off` admits all computer work and records no usage, for a development server; refused with `NODE_ENV=production`.                                      |

Make the Stripe objects once per account (test and live mode are separate),
which prints every value above but the key:

```sh
STRIPE_SECRET_KEY=sk_test_... pnpm --filter @openbots/ee-server setup-stripe --app-url https://app.example.com
```

The webhook endpoint is `<OPENBOTS_PUBLIC_URL>/api/v1/billing/webhook`, for
`checkout.session.completed`, `customer.subscription.created`,
`customer.subscription.updated`, `customer.subscription.deleted`,
`invoice.paid` and `invoice.payment_failed`. The webhook is the only thing
that records a purchase.

To compare the usage ledger with what Fly billed for the Sprites, which
reports and changes nothing (exit 2 when an organization was metered past
the provider's bill):

```sh
DATABASE_URL=... pnpm --filter @openbots/ee-server reconcile --since 2026-11-01 --until 2026-12-01 --csv usage.csv
```

Without `--csv` it asks the Sprites API with `OPENBOTS_SPRITES_TOKEN`. That
adapter is written from assumptions about the API and has not been checked
against a real account; an export with `name` and `awake_seconds` (or
`awake_hours`) columns works today.

## Regenerating the API

After changing a route, regenerate the document and the web types:

```sh
pnpm --filter @openbots/ee-server openapi
pnpm exec prettier --write ee/server/openapi.json
pnpm --filter @openbots/ee-web generate
```
