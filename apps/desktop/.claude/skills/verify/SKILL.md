---
name: verify
description: Verify a change to the OpenBots Mac app (apps/desktop) by running the Electron app against a server. Use before committing any change to the desktop shell, its windows, menus, tray, notifications, local sign-in, updater or release scripts.
---

# Verify a desktop change

The Mac app is an Electron shell around the web app, plus what only a desktop has: the tray, notifications, the local server and sign-in, and updates. Say plainly in the pull request which level below you reached.

## Anywhere: build and unit tests

```sh
pnpm --filter @openbots/desktop typecheck
pnpm --filter @openbots/desktop test      # includes the release and CI scope checks in src/release
pnpm --filter @openbots/desktop build     # tsc and electron-vite build
```

A change to what the window shows is a web change: use the verify skill in `apps/web`, which needs no Mac. This level is `Verified: tests-only` for anything specific to the desktop.

## On a Mac: run the app

```sh
bash scripts/verify-stack.sh start                       # from the repository root
OPENBOTS_DESKTOP_LOCAL_URL=http://localhost:5173 pnpm --filter @openbots/desktop dev
```

`scripts/dev.mjs` makes `.dev/OpenBots.app`, so the menu bar and Dock show the app's own name and icon. Then do what you changed and look at it: the window, the menu item, the tray, a notification arriving while the window is hidden, quitting and opening again (does it come back signed in, at the same place?).

To take a screenshot as evidence: `screencapture -x .verify/desktop.png`.

For a change to packaging, signing, entitlements or the updater, a development run shows nothing. Make an unsigned packaged build and open that:

```sh
pnpm --filter @openbots/desktop dist:dev
open apps/desktop/release/mac*/OpenBots.app
```

`apps/desktop/RELEASING.md` has what a signed release needs. A change to the release workflow only runs on a tag, so read the steps against a dry run of `node scripts/release-version.mjs check` and say in the pull request that the first tagged build is the real test.

This level is `Verified: verify`.
