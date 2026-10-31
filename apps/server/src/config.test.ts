import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_LIMITS, DEFAULT_PROCESS_LIMITS } from '@openbot/shared';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import { generateMasterKey } from './secrets.js';

const base = {
  OPENBOT_MASTER_KEY: generateMasterKey(),
  DATABASE_URL: 'postgres://openbot:openbot@localhost:5432/openbot',
};

describe('loadConfig', () => {
  it('applies defaults', () => {
    const config = loadConfig(base);
    expect(config).toMatchObject({
      publicUrl: 'http://localhost:3000',
      databaseUrl: base.DATABASE_URL,
      sandboxImage: 'ghcr.io/danielpang/openbot/computer:latest',
      deployment: 'self_hosted',
      signupMode: 'first_user_admin',
      filesDir: '/data/files',
      mcpCatalog: { dir: '/opt/openbot/mcp', allowNpx: false },
      role: 'all',
      limits: DEFAULT_LIMITS,
      processLimits: DEFAULT_PROCESS_LIMITS,
    });
    expect(config.redisUrl).toBeUndefined();
    expect(config.dockerHost).toBeUndefined();
    expect(config.sandboxProxy).toBeUndefined();
    expect(config.timezone).toBe('UTC');
    expect(config.sandboxNetwork).toEqual({ name: 'openbot-sandbox', bridge: 'openbot-sandbox' });
  });

  it('takes the Mac app local token on a self-hosted install only', () => {
    const token = 'k'.repeat(43);
    expect(loadConfig(base).localToken).toBeUndefined();
    expect(loadConfig({ ...base, OPENBOT_LOCAL_TOKEN: '' }).localToken).toBeUndefined();
    expect(loadConfig({ ...base, OPENBOT_LOCAL_TOKEN: token }).localToken).toBe(token);
    expect(() =>
      loadConfig({ ...base, OPENBOT_DEPLOYMENT: 'managed', OPENBOT_LOCAL_TOKEN: token }),
    ).toThrow(/OPENBOT_LOCAL_TOKEN: only a self-hosted install/);
    expect(() => loadConfig({ ...base, OPENBOT_LOCAL_TOKEN: 'short' })).toThrow(
      /OPENBOT_LOCAL_TOKEN: must be 32 characters or more/,
    );
  });

  it('reads the sandbox network and its bridge, the bridge named like the network by default', () => {
    expect(loadConfig({ ...base, OPENBOT_SANDBOX_NETWORK: 'openbot-dev' }).sandboxNetwork).toEqual({
      name: 'openbot-dev',
      bridge: 'openbot-dev',
    });
    expect(
      loadConfig({
        ...base,
        OPENBOT_SANDBOX_NETWORK: 'openbot-app-sandbox-254',
        OPENBOT_SANDBOX_BRIDGE: 'openbot-app-254',
      }).sandboxNetwork,
    ).toEqual({ name: 'openbot-app-sandbox-254', bridge: 'openbot-app-254' });
    expect(
      loadConfig({ ...base, OPENBOT_SANDBOX_NETWORK: '', OPENBOT_SANDBOX_BRIDGE: '' })
        .sandboxNetwork,
    ).toEqual({ name: 'openbot-sandbox', bridge: 'openbot-sandbox' });
  });

  it('refuses a sandbox network the bridge or the firewall cannot take', () => {
    // Longer than a Linux interface name, with no bridge name of its own.
    expect(() => loadConfig({ ...base, OPENBOT_SANDBOX_NETWORK: 'openbot-app-sandbox' })).toThrow(
      /invalid configuration:\n {2}OPENBOT_SANDBOX_BRIDGE: needed/,
    );
    for (const bridge of ['openbot-sandbox-2', 'Openbot', 'openbot+']) {
      expect(() => loadConfig({ ...base, OPENBOT_SANDBOX_BRIDGE: bridge })).toThrow(
        /OPENBOT_SANDBOX_BRIDGE/,
      );
    }
    expect(() => loadConfig({ ...base, OPENBOT_SANDBOX_NETWORK: 'no spaces' })).toThrow(
      /OPENBOT_SANDBOX_NETWORK/,
    );
  });

  it('treats empty values as unset', () => {
    const config = loadConfig({
      ...base,
      REDIS_URL: '',
      ANTHROPIC_API_KEY: '',
      OPENBOT_ROLE: '',
      OLLAMA_BASE_URL: '',
    });
    expect(config.redisUrl).toBeUndefined();
    expect(config.providerKeys.anthropic).toBeUndefined();
    expect(config.role).toBe('all');
  });

  it('reads every documented variable', () => {
    const config = loadConfig({
      ...base,
      OPENBOT_PUBLIC_URL: 'https://bots.example.com',
      REDIS_URL: 'redis://redis:6379',
      DOCKER_HOST: 'tcp://docker-socket-proxy:2375',
      OPENBOT_SANDBOX_IMAGE: 'computer:dev',
      OPENBOT_DEPLOYMENT: 'managed',
      OPENBOT_SIGNUP_MODE: 'invite',
      OPENBOT_FILES_DIR: '/tmp/files',
      OPENBOT_MCP_DIR: '/src/docker/mcp-catalog',
      OPENBOT_MCP_NPX_FALLBACK: 'true',
      OPENBOT_ROLE: 'worker',
      ANTHROPIC_API_KEY: 'a',
      OPENAI_API_KEY: 'o',
      XAI_API_KEY: 'x',
      GOOGLE_GENERATIVE_AI_API_KEY: 'g',
      OLLAMA_BASE_URL: 'http://ollama:11434',
      OPENBOT_LIMITS_BOTS_PER_ACCOUNT: '10',
      OPENBOT_LIMITS_BOTS_PER_GROUP: '4',
      OPENBOT_LIMITS_WEBHOOK_IP_RATE_PER_MIN: '1200',
      OPENBOT_LIMITS_WEBHOOK_FAILED_AUTH_PER_MIN: '5',
      OPENBOT_LIMITS_WEBHOOK_ENDPOINT_RATE_PER_MIN: '120',
      OPENBOT_APPROVAL_TTL_MINUTES: '120',
      OPENBOT_MCP_IDLE_STOP_MINUTES: '30',
      OPENBOT_WEB_FETCH_MAX_CHARS: '8000',
      OPENBOT_WEB_FETCH_TIMEOUT_SECONDS: '10',
    });
    expect(config).toMatchObject({
      publicUrl: 'https://bots.example.com',
      redisUrl: 'redis://redis:6379',
      dockerHost: 'tcp://docker-socket-proxy:2375',
      sandboxImage: 'computer:dev',
      deployment: 'managed',
      signupMode: 'invite',
      filesDir: '/tmp/files',
      mcpCatalog: { dir: '/src/docker/mcp-catalog', allowNpx: true },
      role: 'worker',
      providerKeys: {
        anthropic: 'a',
        openai: 'o',
        xai: 'x',
        google: 'g',
        ollamaBaseUrl: 'http://ollama:11434',
      },
    });
    expect(config.limits).toEqual({
      ...DEFAULT_LIMITS,
      botsPerAccount: 10,
      botsPerGroup: 4,
      webhookIpRatePerMin: 1200,
      webhookFailedAuthPerMin: 5,
      webhookEndpointRatePerMin: 120,
    });
    expect(config.processLimits).toEqual({
      approvalTtlMinutes: 120,
      mcpIdleStopMinutes: 30,
      webFetchMaxChars: 8000,
      webFetchTimeoutSeconds: 10,
    });
  });

  it('enables an OAuth provider only when both its id and secret are set', () => {
    const config = loadConfig({
      ...base,
      GITHUB_CLIENT_ID: 'gh-id',
      GITHUB_CLIENT_SECRET: 'gh-secret',
      GOOGLE_CLIENT_ID: 'google-id',
      GOOGLE_CLIENT_SECRET: '',
    });
    expect(config.oauth.github).toEqual({ clientId: 'gh-id', clientSecret: 'gh-secret' });
    expect(config.oauth.google).toBeUndefined();
  });

  it('rejects missing or invalid values with every problem listed', () => {
    expect(() => loadConfig({})).toThrow(
      /OPENBOT_MASTER_KEY[\s\S]*DATABASE_URL|DATABASE_URL[\s\S]*OPENBOT_MASTER_KEY/,
    );
    expect(() => loadConfig({ ...base, OPENBOT_MASTER_KEY: 'short' })).toThrow(/keygen/);
    expect(() => loadConfig({ ...base, OPENBOT_ROLE: 'scheduler' })).toThrow(/OPENBOT_ROLE/);
    expect(() => loadConfig({ ...base, OPENBOT_DEPLOYMENT: 'cloud' })).toThrow(
      /OPENBOT_DEPLOYMENT/,
    );
    expect(() => loadConfig({ ...base, OPENBOT_SIGNUP_MODE: 'anyone' })).toThrow(
      /OPENBOT_SIGNUP_MODE/,
    );
    expect(() => loadConfig({ ...base, OPENBOT_LIMITS_BOTS_PER_GROUP: '0' })).toThrow(
      /OPENBOT_LIMITS_BOTS_PER_GROUP/,
    );
    for (const [name, value] of [
      ['OPENBOT_APPROVAL_TTL_MINUTES', '0'],
      ['OPENBOT_MCP_IDLE_STOP_MINUTES', '-1'],
      ['OPENBOT_WEB_FETCH_MAX_CHARS', '1.5'],
      ['OPENBOT_WEB_FETCH_TIMEOUT_SECONDS', 'soon'],
    ]) {
      expect(() => loadConfig({ ...base, [name!]: value })).toThrow(new RegExp(name!));
    }
    expect(() => loadConfig({ ...base, OPENBOT_PUBLIC_URL: 'not a url' })).toThrow(
      /OPENBOT_PUBLIC_URL/,
    );
    for (const value of ['proxy', '10.0.0.0/33', '10.0.0.0/8/1', 'fd00::/129']) {
      expect(() => loadConfig({ ...base, TRUSTED_PROXIES: value })).toThrow(/TRUSTED_PROXIES/);
    }
  });

  it("reads the computers' egress proxy, which needs its port for the sandbox firewall (plan 9.5)", () => {
    expect(
      loadConfig({ ...base, OPENBOT_SANDBOX_EGRESS_PROXY: 'http://172.30.255.3:8888' })
        .sandboxProxy,
    ).toEqual({ url: 'http://172.30.255.3:8888', noProxy: undefined });
    expect(
      loadConfig({
        ...base,
        OPENBOT_SANDBOX_EGRESS_PROXY: 'https://bot:secret@proxy.example.com:3128/',
        OPENBOT_SANDBOX_NO_PROXY: 'localhost,.example.com',
      }).sandboxProxy,
    ).toEqual({
      url: 'https://bot:secret@proxy.example.com:3128/',
      noProxy: 'localhost,.example.com',
    });
    // NO_PROXY alone sets no proxy.
    expect(loadConfig({ ...base, OPENBOT_SANDBOX_NO_PROXY: 'localhost' }).sandboxProxy).toBe(
      undefined,
    );
    for (const value of [
      'http://172.30.255.3',
      'socks5://172.30.255.3:1080',
      'http://172.30.255.3:8888/path',
      '172.30.255.3:8888',
    ]) {
      expect(() => loadConfig({ ...base, OPENBOT_SANDBOX_EGRESS_PROXY: value })).toThrow(
        /OPENBOT_SANDBOX_EGRESS_PROXY/,
      );
    }
  });

  it("reads the computers' timezone as an IANA name", () => {
    expect(loadConfig({ ...base, OPENBOT_TIMEZONE: 'Europe/London' }).timezone).toBe(
      'Europe/London',
    );
    expect(loadConfig({ ...base, OPENBOT_TIMEZONE: '' }).timezone).toBe('UTC');
    for (const value of ['Mars/Olympus_Mons', 'GMT+25', 'not a zone']) {
      expect(() => loadConfig({ ...base, OPENBOT_TIMEZONE: value })).toThrow(/OPENBOT_TIMEZONE/);
    }
  });

  it('reads TRUSTED_PROXIES as a list of addresses and ranges, empty by default', () => {
    expect(loadConfig(base).trustedProxies).toEqual([]);
    expect(
      loadConfig({ ...base, TRUSTED_PROXIES: ' 172.16.0.0/12, 127.0.0.1,fd00::/8 ' })
        .trustedProxies,
    ).toEqual(['172.16.0.0/12', '127.0.0.1', 'fd00::/8']);
  });

  it('reads OPENBOT_MASTER_KEY_PREVIOUS as a list of keys being rotated out (plan 4.9)', () => {
    expect(loadConfig(base).previousMasterKeys).toEqual([]);
    const [a, b] = [generateMasterKey(), generateMasterKey()];
    expect(
      loadConfig({ ...base, OPENBOT_MASTER_KEY_PREVIOUS: ` ${a}, ${b} ` }).previousMasterKeys,
    ).toEqual([a, b]);
    expect(() => loadConfig({ ...base, OPENBOT_MASTER_KEY_PREVIOUS: `${a},short` })).toThrow(
      /OPENBOT_MASTER_KEY_PREVIOUS: must be comma-separated master keys/,
    );
    expect(() =>
      loadConfig({ ...base, OPENBOT_MASTER_KEY_PREVIOUS: `${a},${base.OPENBOT_MASTER_KEY}` }),
    ).toThrow(/OPENBOT_MASTER_KEY_PREVIOUS: holds OPENBOT_MASTER_KEY itself/);
  });

  it('reads secrets from NAME_FILE, and lists those given in the plain environment (S-1)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'openbot-config-'));
    const file = (name: string, value: string) => {
      writeFileSync(join(dir, name), value, { mode: 0o600 });
      return join(dir, name);
    };
    const key = generateMasterKey();
    const previous = generateMasterKey();
    const config = loadConfig({
      OPENBOT_MASTER_KEY_FILE: file('master_key', `${key}\n`),
      OPENBOT_MASTER_KEY_PREVIOUS_FILE: file('previous', previous),
      DATABASE_URL_FILE: file('database_url', 'postgres://openbot:pw@postgres:5432/openbot\n'),
      ANTHROPIC_API_KEY_FILE: file('anthropic', 'sk-ant\n'),
      OPENAI_API_KEY: 'sk-openai',
    });
    expect(config).toMatchObject({
      masterKey: key,
      previousMasterKeys: [previous],
      databaseUrl: 'postgres://openbot:pw@postgres:5432/openbot',
      providerKeys: { anthropic: 'sk-ant', openai: 'sk-openai' },
      secretsFromEnvironment: ['OPENAI_API_KEY'],
    });
    expect(loadConfig(base).secretsFromEnvironment).toEqual(['OPENBOT_MASTER_KEY', 'DATABASE_URL']);

    expect(() =>
      loadConfig({ ...base, OPENBOT_MASTER_KEY_FILE: file('again', generateMasterKey()) }),
    ).toThrow(/OPENBOT_MASTER_KEY: set either OPENBOT_MASTER_KEY or OPENBOT_MASTER_KEY_FILE/);
    expect(() =>
      loadConfig({
        ...base,
        OPENBOT_MASTER_KEY: '',
        OPENBOT_MASTER_KEY_FILE: join(dir, 'missing'),
      }),
    ).toThrow(/OPENBOT_MASTER_KEY_FILE: cannot read .*missing \(ENOENT\)/);
  });
});
