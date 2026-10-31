import type * as Computer from '@openbot/computer';
import type { DockerProviderOptions } from '@openbot/computer';
import { describe, expect, it, vi } from 'vitest';
import type { AppDeps } from '../context.js';
import { loadConfig } from '../config.js';
import { generateMasterKey } from '../secrets.js';
import { computerProvider } from './computer.js';

// Which provider the server builds from its configuration: the docker one
// gets the sandbox network compose made for this stack (K6).

const made = vi.hoisted(() => [] as DockerProviderOptions[]);
vi.mock('@openbot/computer', async (original) => {
  const actual = await original<typeof Computer>();
  return {
    ...actual,
    createDockerProvider: (options: DockerProviderOptions) => {
      made.push(options);
      return actual.createDockerProvider(options);
    },
  };
});

const depsWith = (env: Record<string, string>) =>
  ({
    config: loadConfig({
      OPENBOT_MASTER_KEY: generateMasterKey(),
      DATABASE_URL: 'postgres://openbot:openbot@localhost:5432/openbot',
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
        OPENBOT_SANDBOX_NETWORK: 'openbot-app-sandbox-254',
        OPENBOT_SANDBOX_BRIDGE: 'openbot-app-254',
      }),
    );
    expect(made).toEqual([
      {
        dockerHost: 'tcp://docker-guard:2375',
        network: { name: 'openbot-app-sandbox-254', bridge: 'openbot-app-254' },
      },
    ]);
  });

  it('gives it openbot-sandbox when nothing is configured', () => {
    made.length = 0;
    computerProvider(depsWith({}));
    expect(made[0]!.network).toEqual({ name: 'openbot-sandbox', bridge: 'openbot-sandbox' });
  });
});
