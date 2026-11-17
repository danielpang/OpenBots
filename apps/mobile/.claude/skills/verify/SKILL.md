---
name: verify
description: Verify a change to the OpenBots iOS app (apps/mobile) on a simulator against a running server. Use before committing any change to a mobile screen, navigation, pairing, sync, push or the transcript, and when asked to check or screenshot the iOS app.
---

# Verify a mobile change

You would not ship an iOS change without trying it in a simulator. A simulator needs a Mac with Xcode. Say plainly in the pull request which of the two levels below you reached.

## Anywhere: the checks that need no simulator

```sh
pnpm --filter @openbots/mobile check:sdk     # Expo SDK and native module versions agree
pnpm --filter @openbots/mobile typecheck
pnpm --filter @openbots/mobile test          # logic (vitest) and native components (jest)
pnpm --filter @openbots/mobile build         # the iOS bundle and Hermes bytecode export
```

The component tests render the real React Native components, so a changed screen should have one. This level is `Verified: tests-only`. It shows the bundle builds and the components render. It does not show the app on a device.

## On a Mac: run it in the simulator

1. Give the app a server to talk to. From the repository root:

   ```sh
   bash scripts/verify-stack.sh start
   pnpm --filter @openbots/server pair --link    # prints an openbots://pair#... link
   ```

2. Build and open the app in a simulator:

   ```sh
   xcrun simctl list devices available
   pnpm --filter @openbots/mobile ios            # development build, with Metro
   ```

   `apps/mobile/README.md` has the fixes for the usual build failures (a missing simulator runtime is exit 70).

3. Pair it. The simulator cannot scan a QR code, so open the link instead:

   ```sh
   xcrun simctl openurl booted 'openbots://pair#...'
   ```

4. Drive what you changed, and take a screenshot as evidence:

   ```sh
   maestro test apps/mobile/maestro/onboarding.yaml        # an existing flow
   xcrun simctl io booted screenshot .verify/mobile.png
   ```

   For a flow that will matter again, add a Maestro flow under `apps/mobile/maestro/` in the same pull request.

5. Check what a phone does that a browser does not, for the screens you touched: background the app and return (the transcript must resync without duplicates), rotate, turn on Dark Mode and large Dynamic Type, and open the keyboard over the composer.

This level is `Verified: verify`.

## What neither level shows

Push notifications, the relay over cellular, Keychain sharing and frame rate need a signed build on a physical device: `apps/mobile/DEVICE-VALIDATION.md`. If your change touches those, say in the pull request that the device pass is still owed.

## The server is older or newer than the app

The app in people's hands was built before your change, and the server may update first. If you changed what the app sends or reads, check both directions: the new app against the server on `main`, and `node scripts/openapi-diff.mjs` for the old app against the new server.
