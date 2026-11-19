# Review instructions for the tunnel

## Always check

- A version 1 client can still read every frame, close code and handshake
  message. A change it cannot read needs `v2` and is Important as an edit to
  version 1
- `docs/RELAY_PROTOCOL.md` changes in the same pull request as the protocol
- The relay never sees plaintext: nothing decrypted is logged, stored or sent
  to metrics
