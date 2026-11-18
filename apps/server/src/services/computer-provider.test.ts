import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as Computer from '@openbots/computer';
import type { DockerProviderOptions, SpritesProviderOptions } from '@openbots/computer';
import { describe, expect, it, vi } from 'vitest';
import type { AppDeps } from '../context.js';
import { loadConfig } from '../config.js';
import { generateMasterKey } from '../secrets.js';
import { computerProvider } from './computer.js';

// Which provider the server builds from its configuration: the docker one
// gets the sandbox network compose made for this stack (K6).

const made = vi.hoisted(() => [] as DockerProviderOptions[]);
const madeSprites = vi.hoisted(() => [] as SpritesProviderOptions[]);
vi.mock('@openbots/computer', async (original) => {
  const actual = await original<typeof Computer>();
  return {
    ...actual,
    createDockerProvider: (options: DockerProviderOptions) => {
      made.push(options);
      return actual.createDockerProvider(options);
    },
    createSpritesProvider: (options: SpritesProviderOptions) => {
      madeSprites.push(options);
      return actual.createSpritesProvider(options);
    },
  };
});

/** A provisioning directory as docker/sprites/ builds it. */
function provisionDir(version = '3\n') {
  const dir = mkdtempSync(join(tmpdir(), 'openbots-sprites-'));
  writeFileSync(join(dir, 'VERSION'), version);
  return dir;
}

const depsWith = (env: Record<string, string>) =>
  ({
    config: loadConfig({
      OPENBOTS_MASTER_KEY: generateMasterKey(),
      DATABASE_URL: 'postgres://openbots:openbots@localhost:5432/openbots',
      DOCKER_HOST: 'tcp://docker-guard:2375',
      ...env,
    }),
    logger: { warn: () => {} },
  }) as unknown as AppDeps;

describe('computerProvider', () => {
  it('gives the docker provider the configured sandbox network', () => {
    made.length = 0;
    computerProvider(
      depsWith({
        OPENBOTS_SANDBOX_NETWORK: 'openbots-app-sandbox-254',
        OPENBOTS_SANDBOX_BRIDGE: 'openbots-a-254',
      }),
    );
    expect(made).toEqual([
      {
        dockerHost: 'tcp://docker-guard:2375',
        network: { name: 'openbots-app-sandbox-254', bridge: 'openbots-a-254' },
      },
    ]);
  });

  it('gives it openbots-sbx when nothing is configured', () => {
    made.length = 0;
    computerProvider(depsWith({}));
    expect(made[0]!.network).toEqual({ name: 'openbots-sbx', bridge: 'openbots-sbx' });
  });

  it('prefers the remote agent, then Sprites, then Docker', () => {
    const dir = provisionDir();
    const sprites = { OPENBOTS_SPRITES_TOKEN: 'org-token', OPENBOTS_SPRITES_PROVISION_DIR: dir };
    expect(computerProvider(depsWith(sprites))?.name).toBe('sprites');
    expect(
      computerProvider(
        depsWith({
          ...sprites,
          OPENBOTS_COMPUTER_AGENT_URL: 'http://vm:7070',
          OPENBOTS_COMPUTER_AGENT_TOKEN: 't',
        }),
      )?.name,
    ).toBe('remote');
    // Unset, the install is as before: Docker.
    expect(computerProvider(depsWith({}))?.name).toBe('docker');
  });

  it('gives the sprites provider its token, prefix, egress, provisioning and timezone', () => {
    madeSprites.length = 0;
    const dir = provisionDir();
    computerProvider(
      depsWith({
        OPENBOTS_SPRITES_TOKEN: 'org-token',
        OPENBOTS_SPRITES_PROVISION_DIR: dir,
        OPENBOTS_SPRITES_NAME_PREFIX: 'obstg',
        OPENBOTS_SPRITES_EGRESS: 'example.com, *.Example.org',
        OPENBOTS_TIMEZONE: 'Europe/London',
      }),
    );
    const [options] = madeSprites;
    expect(options).toMatchObject({
      token: 'org-token',
      namePrefix: 'obstg',
      urlAuth: 'public',
      timezone: 'Europe/London',
      provision: {
        scriptPath: join(dir, 'provision.sh'),
        bundlePath: join(dir, 'agent-bundle.tgz'),
        version: '3',
      },
    });
    const domains = options!.egress!.rules.map((rule) => rule.domain);
    expect(options!.egress!.rules[0]).toEqual({ include: 'defaults' });
    expect(domains).toContain('example.com');
    expect(domains).toContain('*.example.org');
    expect(domains).toContain('*.anthropic.com');
  });

  it('refuses a Sprites token without the provisioning, and bad egress domains', () => {
    expect(() => depsWith({ OPENBOTS_SPRITES_TOKEN: 'org-token' })).toThrow(
      /OPENBOTS_SPRITES_PROVISION_DIR/,
    );
    expect(() =>
      depsWith({
        OPENBOTS_SPRITES_TOKEN: 'org-token',
        OPENBOTS_SPRITES_PROVISION_DIR: provisionDir(),
        OPENBOTS_SPRITES_EGRESS: 'https://example.com',
      }),
    ).toThrow(/OPENBOTS_SPRITES_EGRESS/);
    expect(() =>
      depsWith({
        OPENBOTS_SPRITES_TOKEN: 'org-token',
        OPENBOTS_SPRITES_PROVISION_DIR: provisionDir(),
        OPENBOTS_SPRITES_NAME_PREFIX: 'Bad_Prefix',
      }),
    ).toThrow(/OPENBOTS_SPRITES_NAME_PREFIX/);
  });
});
