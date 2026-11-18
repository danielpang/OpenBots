# Review instructions for the iOS app

## Always check

- The app still works against the server release before this change. It
  ships on its own schedule, so it meets older and newer servers
- After a reconnect or a return from the background, the transcript resyncs
  without duplicate or missing messages
- Tokens and pairing keys are kept in the Keychain, never in plain storage or
  a log
- The pull request says whether the change ran in a simulator. If it did not,
  and it changes a screen, ask for that as a Nit
