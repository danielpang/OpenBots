# Review instructions for the Bot computer and docker guard

## What Important means here

Any change that widens what a Bot's computer can reach or do is Important,
whatever its size: a new capability, mount, published port or network, a
looser firewall rule, or a container that runs as root where it did not.

## Always check

- The pull request says which steps of `docs/plans/RELEASE_CHECKS.md` were run
  on a Docker host, with their output. Without that, ask for it as Important
  when the change touches isolation
- A request the docker guard refuses stays refused. A new allowed endpoint,
  image or host setting is Important and needs a test of the refusal beside it
- No secret is written into a container's environment that a Bot's commands
  can read
