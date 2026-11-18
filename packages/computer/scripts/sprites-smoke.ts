// A live check of the Sprites API calls the sprites provider makes, against a
// real Fly org. Not run in CI: it costs a little and needs a token.
//
//   SPRITES_TOKEN=... pnpm --filter @openbots/computer sprites-smoke
//
// It creates a throwaway Sprite, runs a command, writes and reads a file,
// applies an egress policy, takes and drops a Tasks API hold, then checks the
// two URL modes the provider can use: a public URL with only our header, and
// a private URL with the org token in `Authorization` and our token in
// `X-OpenBots-Agent-Token`. For the private URL it reports whether the
// Sprites proxy passes `Authorization` (the org token) on to the Sprite, which
// decides whether OPENBOTS_SPRITES_URL_AUTH=sprite is safe. The Sprite is
// deleted at the end, also on failure.

import { randomBytes } from 'node:crypto';
import { createSpritesApi } from '../src/sprites-api.js';
import { spritesEgressPolicy } from '../src/sprites.js';

const token = process.env.SPRITES_TOKEN;
if (!token) {
  console.log('SPRITES_TOKEN is not set: skipping the Sprites smoke test');
  process.exit(0);
}

const api = createSpritesApi({ token, baseUrl: process.env.SPRITES_API_URL });
const name = `ob-smoke-${randomBytes(4).toString('hex')}`;
const step = (what: string) => console.log(`- ${what}`);

// Answers with which of the two headers reached the Sprite, never their values.
const ECHO_SERVER = `
require('node:http').createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({
    authorization: req.headers.authorization !== undefined,
    agentToken: req.headers['x-openbots-agent-token'] === process.env.EXPECT,
  }));
}).listen(8080);
`;

async function urlCheck(url: string, headers: Record<string, string>) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const response = await fetch(url, { headers }).catch(() => null);
    if (response?.ok) return (await response.json()) as Record<string, boolean>;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`${url} did not answer`);
}

async function main() {
  step(`create ${name}`);
  const created = await api.create(name, { urlAuth: 'public' });
  step(`url ${created.url}, status ${created.status}`);

  const echo = await api.exec(name, ['bash', '-c', 'echo "$GREETING from $(uname -sm)"'], {
    env: { GREETING: 'hello' },
  });
  step(`exec: exit ${echo.exitCode}, ${echo.stdout.trim()}`);
  if (echo.exitCode !== 0) throw new Error(echo.stderr);
  const piped = await api.exec(name, ['bash', '-c', 'IFS= read -r line; echo "${#line}"'], {
    stdin: 'secret-on-stdin\n',
  });
  step(`stdin: read ${piped.stdout.trim()} characters`);

  await api.writeFile(name, '/var/tmp/openbots-smoke/hello.txt', new TextEncoder().encode('hi'));
  const read = await api.readFile(name, '/var/tmp/openbots-smoke/hello.txt');
  step(`fs: wrote and read ${read ? new TextDecoder().decode(read) : 'nothing'}`);
  step(`fs: a missing file reads ${await api.readFile(name, '/nonexistent/file')}`);

  await api.setNetworkPolicy(name, spritesEgressPolicy());
  const dns = await api.exec(name, [
    'bash',
    '-c',
    'getent hosts api.anthropic.com >/dev/null && echo allowed; getent hosts example.net >/dev/null && echo leaked || echo refused',
  ]);
  step(`egress policy: ${dns.stdout.trim().replace(/\n/g, ', ')}`);

  const hold = await api.exec(name, [
    'curl',
    '-sS',
    '--unix-socket',
    '/.sprite/api.sock',
    '-X',
    'PUT',
    'http://sprite/v1/tasks/openbots-smoke',
    '-H',
    'content-type: application/json',
    '-d',
    '{"expire":60}',
    '-o',
    '/dev/null',
    '-w',
    '%{http_code}',
  ]);
  step(`hold: HTTP ${hold.stdout}`);
  const release = await api.exec(name, [
    'curl',
    '-sS',
    '--unix-socket',
    '/.sprite/api.sock',
    '-X',
    'DELETE',
    'http://sprite/v1/tasks/openbots-smoke',
    '-o',
    '/dev/null',
    '-w',
    '%{http_code}',
  ]);
  step(`release: HTTP ${release.stdout}`);

  const agentToken = randomBytes(16).toString('hex');
  await api.writeFile(
    name,
    '/var/tmp/openbots-smoke/echo.js',
    new TextEncoder().encode(ECHO_SERVER),
  );
  const service = await api.exec(name, [
    'sprite-env',
    'services',
    'create',
    'openbots-smoke',
    '--cmd',
    'env',
    '--args',
    `EXPECT=${agentToken},node,/var/tmp/openbots-smoke/echo.js`,
    '--http-port',
    '8080',
  ]);
  step(`service: exit ${service.exitCode}`);

  const open = await urlCheck(created.url, { 'x-openbots-agent-token': agentToken });
  step(`public URL: our header arrives ${open.agentToken}`);

  await api.setUrlAuth(name, 'sprite');
  const anonymous = await fetch(created.url).catch(() => null);
  step(`private URL without a token: HTTP ${anonymous?.status ?? 'no answer'}`);
  const both = await urlCheck(created.url, {
    authorization: `Bearer ${token}`,
    'x-openbots-agent-token': agentToken,
  });
  step(`private URL: our header arrives ${both.agentToken}`);
  step(
    both.authorization
      ? 'private URL: the proxy PASSES Authorization (the org token) to the Sprite: keep OPENBOTS_SPRITES_URL_AUTH=public'
      : 'private URL: the proxy strips Authorization: OPENBOTS_SPRITES_URL_AUTH=sprite is safe',
  );

  const id = await api.createCheckpoint(name, 'smoke');
  step(
    `checkpoint ${id}; listed: ${(await api.listCheckpoints(name)).map((c) => c.id).join(', ')}`,
  );
}

try {
  await main();
  console.log('Sprites smoke test passed');
} catch (error) {
  console.error('Sprites smoke test failed:', error);
  process.exitCode = 1;
} finally {
  await api.delete(name).catch((error: unknown) => console.error(`deleting ${name}:`, error));
  step(`deleted ${name}`);
}
