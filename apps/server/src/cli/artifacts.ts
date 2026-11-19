import { parseHostname } from '../artifact-host/handler.js';
import { setTakedown } from '../services/artifact-sharing.js';
import type { CliContext, CliResult } from './context.js';

// `openbots artifacts takedown <link> [reason]` and `openbots artifacts
// restore <link>` (plan 21.11): the operator's switch for a public link that
// is being abused, a phishing page say. It takes effect at once on this
// server; the edge keeps a public answer for at most a minute. Audited in
// the Artifact's organization as the system. The owner and the
// organization's members still see the Artifact; it cannot be made public
// again until restored.

export const ARTIFACTS_USAGE =
  'usage: openbots artifacts takedown <link> [reason] | openbots artifacts restore <link>';

export async function runArtifacts(args: string[], ctx: CliContext): CliResult {
  const { config, write } = ctx;
  const [command, link, ...reason] = args;
  if ((command !== 'takedown' && command !== 'restore') || !link) {
    write(ARTIFACTS_USAGE);
    return 2;
  }
  if (!config.artifactHost) {
    write('artifacts: this server does not host Artifacts (OPENBOTS_ARTIFACT_DOMAIN is not set)');
    return 1;
  }
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    write(`artifacts: not a link: ${link}`);
    return 2;
  }
  const target = parseHostname(url.hostname, config.artifactHost.domain);
  const artifactId = /^\/([0-9a-f-]{36})\/?/.exec(url.pathname)?.[1];
  if (!target || !artifactId) {
    write(`artifacts: not a link to an Artifact on ${config.artifactHost.domain}`);
    return 2;
  }
  const down = command === 'takedown';
  const done = await setTakedown(
    ctx,
    { ...target, artifactId },
    down,
    down && reason.length ? reason.join(' ').slice(0, 500) : null,
  );
  if (!done) {
    write(`artifacts: no Artifact at ${link}`);
    return 1;
  }
  write(
    down
      ? `Took down the public link to "${done.title}". Its owner and organization still see it.`
      : `Restored "${done.title}". Its owner may make it public again.`,
  );
  return 0;
}
