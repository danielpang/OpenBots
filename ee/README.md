# ee: OpenBots Enterprise Edition

Code for the managed OpenBots service lives here: organizations and admin
features, billing and Stripe, and anything else that is not part of
self-hosted OpenBots.

Everything in this directory is proprietary and covered by
[ee/LICENSE](LICENSE). The rest of the repository is under the Business Source
License in the root [LICENSE](../LICENSE).

Rules for code here:

- The core (`apps/`, `packages/`) never imports from `ee/`. Enterprise code
  plugs into the core through its extension points, so self-hosted OpenBots
  builds and runs without this directory.
- Enterprise code runs only when `OPENBOT_DEPLOYMENT=managed`.
