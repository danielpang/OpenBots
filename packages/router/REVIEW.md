# Review instructions for the router

## Always check

- Every new way to start a run goes through `withinChainLimits` with the right
  depth and `botTriggered`. A path that skips it lets Bots answer each other
  without end, and is Important
- The owner's own messages are never charged to the Bot run budget
