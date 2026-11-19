# Review instructions for the images and compose files

## What Important means here

Any change that widens what a Bot's computer can reach or do is Important,
whatever its size: a new capability, mount, published port or network, a
looser firewall rule, or a container that runs as root where it did not.

## Always check

- The pull request says which steps of `docs/plans/RELEASE_CHECKS.md` were run
  on a Docker host, with their output. Without that, ask for it as Important
  when the change touches isolation
- A volume written by the previous release still boots: the standalone image
  restarts on old data
- Base images and downloaded tools stay pinned by digest or version
- No secret is written into an image layer or a compose file
