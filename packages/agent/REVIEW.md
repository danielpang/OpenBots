# Review instructions for the agent runtime

## Always check

- A trigger override only raises a tool's decision (auto, then ask, then
  deny). Anything that lets a webhook's or another Bot's run ask less than the
  owner's own is Important
- A tool is looked up by name with `ownEntry`, never with a plain index into
  an object. A tool can be named `constructor`
- A new tool that changes something has a default rule in
  `src/policy/rules.ts` that asks
- After pruning, compaction or a resume, every tool result still follows its
  tool call with a matching id. A provider rejects the conversation otherwise
- Nothing that changes from turn to turn (a time, a count, a reordered list)
  is placed before a prompt cache breakpoint in `src/context/`
