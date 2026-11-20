import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppDeps } from '../context.js';
import { createInfra, type Infra } from '../infra/index.js';
import { generateMasterKey } from '../secrets.js';
import { artifactHostDeps, MemoryClaims } from './mount.js';

// A view token is good once (plan 21.11): the host claims its nonce. With
// REDIS_URL the claim is in Redis, shared by every API process; without it
// the server is one process, and the claim is in its memory.

const masterKey = generateMasterKey();
const open: Infra[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((infra) => infra.close()));
});

/** The artifact host's deps as one server process builds them. */
function hostOf(redisUrl: string | undefined) {
  const infra = createInfra({ redisUrl });
  open.push(infra);
  const deps = {
    config: { artifactHost: { domain: 'openbots-artifacts.test' }, masterKey },
    infra,
  } as unknown as AppDeps;
  return { host: artifactHostDeps(deps)!, infra };
}

describe('claiming a view token', () => {
  it('keeps a claim in one process without Redis, whatever floods the rate limiter', async () => {
    const { host, infra } = hostOf(undefined);
    const nonce = randomUUID();
    expect(await host.claim(nonce)).toBe(true);
    expect(await host.claim(nonce)).toBe(false);
    // Requests from many addresses fill the limiter's buckets past its cap.
    for (let i = 0; i <= 100_000; i++) {
      await infra.limiter.consume(`artifact-host:203.0.113.${i}`, { window: 60, max: 100 });
    }
    expect(await host.claim(nonce)).toBe(false);
  });

  it('refuses a new claim rather than forget a live one, and frees expired ones', () => {
    let now = 0;
    const claims = new MemoryClaims(2, () => now);
    expect(claims.claim('a', 1_000)).toBe(true);
    expect(claims.claim('b', 1_000)).toBe(true);
    expect(claims.claim('c', 1_000)).toBe(false);
    expect(claims.claim('a', 1_000)).toBe(false);
    now = 1_000;
    expect(claims.claim('c', 1_000)).toBe(true);
    expect(claims.claim('c', 1_000)).toBe(false);
  });

  it.skipIf(!process.env.REDIS_URL)(
    'claims in Redis, so a second API process refuses the same token',
    async () => {
      const one = hostOf(process.env.REDIS_URL);
      const two = hostOf(process.env.REDIS_URL);
      const nonce = randomUUID();
      expect(await one.host.claim(nonce)).toBe(true);
      expect(await two.host.claim(nonce)).toBe(false);
      expect(await one.host.claim(nonce)).toBe(false);
    },
  );
});
