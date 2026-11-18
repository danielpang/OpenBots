import {
  createDockerProvider,
  createSpritesProvider,
  type ComputerProvider,
} from '@openbots/computer';
import {
  fakeSpritesApi,
  mockDocker,
  startFakeAgent,
  type FakeAgent,
  type FakeSpritesApi,
  type MockDocker,
} from '@openbots/computer/testing';
import type { AppDeps } from './context.js';
import { setComputerProvider } from './services/computer.js';

// A computer for server tests: the docker provider over a mocked dockerode,
// whose containers' agent is an in-process fake (no daemon). The fake accepts
// the token the server generated for the container, so the
// sealed-token round trip is exercised.

export interface TestComputer {
  agent: FakeAgent;
  docker: MockDocker;
  provider: ComputerProvider;
  close(): Promise<void>;
}

export async function useTestComputer(deps: AppDeps): Promise<TestComputer> {
  const agent = await startFakeAgent({ token: 'not-yet-created' });
  const docker = mockDocker();
  const inner = createDockerProvider({ docker, agentUrl: () => agent.url, pollMs: 5 });
  const provider: ComputerProvider = {
    ...inner,
    async create(spec) {
      const ref = await inner.create(spec);
      agent.token = spec.agentToken;
      return ref;
    },
  };
  setComputerProvider(deps, provider);
  return { agent, docker, provider, close: () => agent.close() };
}

export interface TestSprites {
  agent: FakeAgent;
  api: FakeSpritesApi;
  provider: ComputerProvider;
  close(): Promise<void>;
}

/**
 * A computer on the sprites provider for server tests: the Sprites API is a
 * fake (no Fly), each Sprite's URL is the fake agent, and the provisioning
 * hands the fake agent the token the server generated.
 */
export async function useTestSprites(deps: AppDeps): Promise<TestSprites> {
  const agent = await startFakeAgent({ token: 'not-yet-created' });
  const api = fakeSpritesApi();
  api.urlFor = () => agent.url;
  const record = api.provisionScript;
  api.provisionScript = (sprite, run) => {
    agent.token = run.token;
    return record(sprite, run);
  };
  const provider = createSpritesProvider({
    token: 'org-token',
    api,
    provision: { scriptPath: 'provision.sh', bundlePath: 'agent-bundle.tgz', version: '1' },
    readLocalFile: async (path) => new TextEncoder().encode(path),
    pollMs: 5,
    deleteTimeoutMs: 100,
  });
  setComputerProvider(deps, provider);
  return { agent, api, provider, close: () => agent.close() };
}
