import { describe, expect, it } from 'vitest';
import { parseHostname } from '../artifact-host/handler.js';
import { loadConfig } from '../config.js';
import { generateMasterKey } from '../secrets.js';
import { artifactHostKeys, artifactHostUrl, botPublicSlug } from './artifact-sharing.js';

// The names on the artifact domain and its configuration (plan 21.11).

const config = (env: Record<string, string>) =>
  loadConfig({
    OPENBOTS_MASTER_KEY: generateMasterKey(),
    DATABASE_URL: 'postgres://unused',
    OPENBOTS_PUBLIC_URL: 'https://app.openbots.example',
    ...env,
  });

describe('Bot public slugs', () => {
  it('keep the handle readable and fit the label with the organization slug', () => {
    expect(botPublicSlug('researcher', 'acme-1a2b3c4d', '0f0f0f0f')).toBe('researcher-0f0f0f0f');
    expect(botPublicSlug('Ünïcode__Bot--x', 'acme-1a2b3c4d', '0f0f0f0f')).toBe(
      'n-code-bot-x-0f0f0f0f',
    );
    expect(botPublicSlug('---', 'acme', '0f0f0f0f')).toBe('bot-0f0f0f0f');
    const longOrg = `${'o'.repeat(40)}-1a2b3c4d`;
    const slug = botPublicSlug('a-very-long-handle-for-a-bot', longOrg, '0f0f0f0f');
    expect(`${slug}--${longOrg}`.length).toBeLessThanOrEqual(63);
    expect(slug).not.toContain('--');
    expect(parseHostname(`${slug}--${longOrg}.x.test`, 'x.test')).toEqual({
      botSlug: slug,
      orgSlug: longOrg,
    });
  });

  it('never put -- inside or end on a hyphen, for any handle', () => {
    for (const handle of ['a-', '-a', 'a--b', 'a_-_b', 'ab', 'x'.repeat(80), '--xn--']) {
      const slug = botPublicSlug(handle, 'acme-1a2b3c4d');
      expect(slug, handle).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(slug.length).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('artifact host configuration', () => {
  it('is off without OPENBOTS_ARTIFACT_DOMAIN', () => {
    expect(config({}).artifactHost).toBeUndefined();
    expect(() => config({ OPENBOTS_ARTIFACT_EDGE_SECRET: 's'.repeat(40) })).toThrow(
      /OPENBOTS_ARTIFACT_EDGE_SECRET/,
    );
  });

  it('refuses a domain that shares the app host or sits under it', () => {
    for (const domain of ['app.openbots.example', 'x.app.openbots.example', 'openbots.example']) {
      expect(() => config({ OPENBOTS_ARTIFACT_DOMAIN: domain }), domain).toThrow(
        /OPENBOTS_ARTIFACT_DOMAIN/,
      );
    }
    expect(() => config({ OPENBOTS_ARTIFACT_DOMAIN: 'https://x.test/' })).toThrow();
    expect(config({ OPENBOTS_ARTIFACT_DOMAIN: 'OpenBots-Artifacts.example' }).artifactHost).toEqual(
      {
        domain: 'openbots-artifacts.example',
      },
    );
  });

  it('builds https links, and none for a Bot that is gone or a label too long', () => {
    const c = config({ OPENBOTS_ARTIFACT_DOMAIN: 'openbots-artifacts.example' });
    expect(artifactHostUrl(c, 'writer-0f0f0f0f', 'acme-1a2b3c4d', 'id')).toBe(
      'https://writer-0f0f0f0f--acme-1a2b3c4d.openbots-artifacts.example/id/',
    );
    expect(artifactHostUrl(c, null, 'acme', 'id')).toBeNull();
    expect(artifactHostUrl(c, 'w'.repeat(40), 'o'.repeat(30), 'id')).toBeNull();
    expect(artifactHostUrl(config({}), 'writer-0f0f0f0f', 'acme', 'id')).toBeNull();
  });

  it('derives a key for each purpose from the master key', () => {
    const key = generateMasterKey();
    const a = artifactHostKeys(key);
    expect(Buffer.from(a.token).equals(Buffer.from(a.cookie))).toBe(false);
    expect(Buffer.from(artifactHostKeys(key).token).equals(Buffer.from(a.token))).toBe(true);
    expect(
      Buffer.from(artifactHostKeys(generateMasterKey()).token).equals(Buffer.from(a.token)),
    ).toBe(false);
  });
});
