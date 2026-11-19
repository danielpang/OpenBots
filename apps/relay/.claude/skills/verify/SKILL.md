---
name: verify
description: Verify a change to the OpenBots relay or tunnel (apps/relay, packages/tunnel) by running the relay and connecting to it. Use before committing any change to relay routing, the registry, the tunnel handshake or the relay protocol.
---

# Verify a relay change

## Run it

```sh
RELAY_PORT=3200 pnpm --filter @openbots/relay exec tsx --conditions=@openbots/source src/main.ts &
curl -fsS http://127.0.0.1:3200/healthz
```

Without `RELAY_REDIS_URL` the registry is in memory, which is enough for one relay. For a change to the shared registry or to how two relays hand a stream over, start Redis (`bash scripts/dev.sh`) and run two relays on different ports with the same `RELAY_REDIS_URL`.

## Drive it

The relay only matters with a server behind it and a client in front. The tests in `apps/relay/src` and `packages/tunnel/src` open real sockets between both ends in one process: run them, then run the one closest to your change on its own and read what it asserts.

```sh
pnpm turbo run test --filter @openbots/relay --filter @openbots/tunnel
```

For a change a phone would notice, pair for real: start the stack (`bash scripts/verify-stack.sh start`), point the server at your relay as `docs/PRIVATE_RELAY_SETUP.md` describes, and run `pnpm --filter @openbots/server pair`. The pairing link it prints is what the app scans.

## The protocol is a contract

Phones in the field speak the version they shipped with (`docs/RELAY_PROTOCOL.md`). If your change alters a frame, a close code or the handshake, a version 1 client must still be able to read it, or it needs `v2`. Update the document in the same commit.

Stamp the commit `Verified: verify` when you ran the relay and connected to it, `Verified: tests-only` when you ran only the tests.
