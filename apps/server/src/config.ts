import {
  DEFAULT_SANDBOX_IMAGE,
  resolveSandboxNetwork,
  type SandboxNetwork,
} from '@openbot/computer';
import { DEFAULT_CATALOG_INSTALL_DIR, type CatalogInstall } from '@openbot/mcp';
import { isValidTimezone } from '@openbot/routines';
import {
  LIMIT_ENV_VARS,
  PROCESS_LIMIT_ENV_VARS,
  resolveLimits,
  resolveProcessLimits,
  type Limits,
  type ProcessLimits,
} from '@openbot/shared';
import { z } from 'zod';
import { isCidr } from './client-ip.js';
import { resolveSecretFiles } from './env-files.js';
import { parseMasterKey } from './secrets.js';

// Server configuration from the environment (plan 16.2). Empty values count as
// unset, so a copied `.env.example` with blank keys parses cleanly. Secrets may
// come from files instead (NAME_FILE, see env-files.ts).

const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema.optional());

const withDefault = <T extends z.ZodType>(schema: T, fallback: z.input<T>) =>
  z.preprocess((value) => (value === '' || value === undefined ? fallback : value), schema);

const masterKey = z.string().refine(
  (value) => {
    try {
      parseMasterKey(value);
      return true;
    } catch {
      return false;
    }
  },
  { message: 'must be 32 bytes, base64-encoded (generate one with `keygen`)' },
);

/** Master keys being rotated out (plan 4.9): comma-separated, each like OPENBOT_MASTER_KEY. */
const masterKeyList = z
  .string()
  .transform((value) =>
    value
      .split(',')
      .map((key) => key.trim())
      .filter(Boolean),
  )
  .refine((keys) => keys.every((key) => masterKey.safeParse(key).success), {
    message: 'must be comma-separated master keys, each 32 bytes, base64-encoded',
  });

/** A comma-separated list of addresses and CIDR ranges. */
const cidrList = z
  .string()
  .transform((value) =>
    value
      .split(',')
      .map((range) => range.trim())
      .filter(Boolean),
  )
  .refine((ranges) => ranges.every(isCidr), {
    message: 'must be comma-separated addresses or CIDR ranges, e.g. 172.16.0.0/12',
  });

/**
 * The computers' egress proxy: an http(s) URL with its port spelled out, the
 * form docker/sandbox-firewall.sh parses for its exception.
 */
const proxyUrl = z
  .url({ protocol: /^https?$/ })
  .regex(/^https?:\/\/([^/@]+@)?[^/@:]+:\d{1,5}\/?$/, {
    message: 'must look like http://172.30.255.3:8888, with the port',
  });

const limitsShape = Object.fromEntries(
  [...Object.values(LIMIT_ENV_VARS), ...Object.values(PROCESS_LIMIT_ENV_VARS)].map((name) => [
    name,
    optional(z.coerce.number().int().positive()),
  ]),
);

const envSchema = z.object({
  OPENBOT_PUBLIC_URL: withDefault(z.url(), 'http://localhost:3000'),
  OPENBOT_MASTER_KEY: masterKey,
  OPENBOT_MASTER_KEY_PREVIOUS: withDefault(masterKeyList, ''),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: optional(z.string()),
  DOCKER_HOST: optional(z.string()),
  OPENBOT_SANDBOX_IMAGE: withDefault(z.string(), DEFAULT_SANDBOX_IMAGE),
  // Checked together by resolveSandboxNetwork below.
  OPENBOT_SANDBOX_NETWORK: optional(z.string()),
  OPENBOT_SANDBOX_BRIDGE: optional(z.string()),
  OPENBOT_SANDBOX_EGRESS_PROXY: optional(proxyUrl),
  OPENBOT_SANDBOX_NO_PROXY: optional(z.string()),
  OPENBOT_TIMEZONE: withDefault(
    z.string().refine(isValidTimezone, {
      message: 'must be an IANA timezone name, e.g. Europe/London',
    }),
    'UTC',
  ),
  OPENBOT_COMPUTER_AGENT_URL: optional(z.url()),
  OPENBOT_COMPUTER_AGENT_TOKEN: optional(z.string()),
  OPENBOT_COMPUTER_AGENT_SHARED: withDefault(z.stringbool(), 'false'),
  OPENBOT_DEPLOYMENT: withDefault(z.enum(['self_hosted', 'managed']), 'self_hosted'),
  OPENBOT_SIGNUP_MODE: withDefault(
    z.enum(['first_user_admin', 'invite', 'open']),
    'first_user_admin',
  ),
  OPENBOT_FILES_DIR: withDefault(z.string(), '/data/files'),
  OPENBOT_MCP_DIR: withDefault(z.string(), DEFAULT_CATALOG_INSTALL_DIR),
  OPENBOT_MCP_NPX_FALLBACK: withDefault(z.stringbool(), 'false'),
  OPENBOT_ROLE: withDefault(z.enum(['api', 'worker', 'all']), 'all'),
  OPENBOT_METRICS_TOKEN: optional(z.string().min(16)),
  TRUSTED_PROXIES: withDefault(cidrList, ''),
  ANTHROPIC_API_KEY: optional(z.string()),
  OPENAI_API_KEY: optional(z.string()),
  XAI_API_KEY: optional(z.string()),
  GOOGLE_GENERATIVE_AI_API_KEY: optional(z.string()),
  OLLAMA_BASE_URL: optional(z.url()),
  GITHUB_CLIENT_ID: optional(z.string()),
  GITHUB_CLIENT_SECRET: optional(z.string()),
  GOOGLE_CLIENT_ID: optional(z.string()),
  GOOGLE_CLIENT_SECRET: optional(z.string()),
  ...limitsShape,
});

export type Deployment = 'self_hosted' | 'managed';

export interface OAuthClient {
  clientId: string;
  clientSecret: string;
}

export interface Config {
  publicUrl: string;
  /** Base64; seals every new secret. Open secrets with `keyringFromConfig`. */
  masterKey: string;
  /**
   * Base64 keys being rotated out (OPENBOT_MASTER_KEY_PREVIOUS): they still
   * open secrets sealed under them until `rotate-key` re-seals those.
   */
  previousMasterKeys: string[];
  /** Secrets given in the plain environment rather than as NAME_FILE (S-1); main.ts warns. */
  secretsFromEnvironment: string[];
  databaseUrl: string;
  redisUrl?: string;
  dockerHost?: string;
  sandboxImage: string;
  /**
   * The network computers are created on and its bridge
   * (OPENBOT_SANDBOX_NETWORK, OPENBOT_SANDBOX_BRIDGE): compose's sandbox
   * network, which the docker guard and the sandbox firewall are set to as well.
   */
  sandboxNetwork: SandboxNetwork;
  /** The HTTP proxy the computers' web traffic goes through, and what skips it (plan 9.5). */
  sandboxProxy?: { url: string; noProxy?: string };
  /**
   * The instance's timezone (IANA name, default UTC): the computers' clock, so
   * the Bots' shells, browsers and the wallpaper follow the owner's day.
   */
  timezone: string;
  /**
   * The `remote` computer provider (plan 9.2): a control agent already running
   * at this URL. When set it is used instead of Docker. It is one machine:
   * the first account to use it keeps it, unless `shared` lets every account
   * on the install use it (and share its files and logins).
   */
  computerAgent?: { url: string; token: string; shared: boolean };
  /**
   * What kind of install this is (OPENBOT_DEPLOYMENT). `self_hosted`, the
   * default, is a personal install with one account, its owner: sign-up
   * closes once it exists, and the members, invites and audit log routes
   * answer 404. `managed` is the hosted OpenBots service, where admins
   * manage members.
   */
  deployment: Deployment;
  /** Who may sign up after the first user. Managed only; self-hosted is always closed. */
  signupMode: 'first_user_admin' | 'invite' | 'open';
  filesDir: string;
  /** The catalog's pre-installed stdio servers (S-20). */
  mcpCatalog: CatalogInstall;
  role: 'api' | 'worker' | 'all';
  /** Bearer token for `GET /metrics`; metrics are off without one. */
  metricsToken?: string;
  /**
   * Reverse proxies and tunnels whose `X-Forwarded-For` is believed (CIDR
   * ranges). Empty means the header is ignored (see client-ip.ts).
   */
  trustedProxies: string[];
  providerKeys: {
    anthropic?: string;
    openai?: string;
    xai?: string;
    google?: string;
    ollamaBaseUrl?: string;
  };
  /** Sign-in providers (U1), each enabled only when both its id and secret are set. */
  oauth: {
    github?: OAuthClient;
    google?: OAuthClient;
  };
  limits: Limits;
  /**
   * Approval expiry, the MCP idle stop and the web_fetch caps
   * (OPENBOT_APPROVAL_TTL_MINUTES and so on): set at start, not admin settings.
   */
  processLimits: ProcessLimits;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const secrets = resolveSecretFiles(env);
  const parsed = envSchema.safeParse(secrets.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`invalid configuration:\n${issues.join('\n')}`);
  }
  const e = parsed.data;
  if (e.OPENBOT_MASTER_KEY_PREVIOUS.includes(e.OPENBOT_MASTER_KEY.trim())) {
    throw new Error(
      'invalid configuration:\n  OPENBOT_MASTER_KEY_PREVIOUS: holds OPENBOT_MASTER_KEY itself; list only the keys being replaced',
    );
  }
  let sandboxNetwork: SandboxNetwork;
  try {
    sandboxNetwork = resolveSandboxNetwork(e.OPENBOT_SANDBOX_NETWORK, e.OPENBOT_SANDBOX_BRIDGE);
  } catch (error) {
    throw new Error(`invalid configuration:\n  ${(error as Error).message}`, { cause: error });
  }
  const raw = e as Record<string, unknown>;
  const limitOverrides: Partial<Limits> = {};
  for (const [key, name] of Object.entries(LIMIT_ENV_VARS) as [keyof Limits, string][]) {
    limitOverrides[key] = raw[name] as number | undefined;
  }
  const processOverrides: Partial<ProcessLimits> = {};
  for (const [key, name] of Object.entries(PROCESS_LIMIT_ENV_VARS) as [
    keyof ProcessLimits,
    string,
  ][]) {
    processOverrides[key] = raw[name] as number | undefined;
  }
  return {
    publicUrl: e.OPENBOT_PUBLIC_URL,
    masterKey: e.OPENBOT_MASTER_KEY,
    previousMasterKeys: e.OPENBOT_MASTER_KEY_PREVIOUS,
    secretsFromEnvironment: secrets.fromEnvironment,
    databaseUrl: e.DATABASE_URL,
    redisUrl: e.REDIS_URL,
    dockerHost: e.DOCKER_HOST,
    sandboxImage: e.OPENBOT_SANDBOX_IMAGE,
    sandboxNetwork,
    sandboxProxy: e.OPENBOT_SANDBOX_EGRESS_PROXY
      ? { url: e.OPENBOT_SANDBOX_EGRESS_PROXY, noProxy: e.OPENBOT_SANDBOX_NO_PROXY }
      : undefined,
    timezone: e.OPENBOT_TIMEZONE,
    computerAgent: e.OPENBOT_COMPUTER_AGENT_URL
      ? {
          url: e.OPENBOT_COMPUTER_AGENT_URL,
          token: e.OPENBOT_COMPUTER_AGENT_TOKEN ?? '',
          shared: e.OPENBOT_COMPUTER_AGENT_SHARED,
        }
      : undefined,
    deployment: e.OPENBOT_DEPLOYMENT,
    signupMode: e.OPENBOT_SIGNUP_MODE,
    filesDir: e.OPENBOT_FILES_DIR,
    mcpCatalog: { dir: e.OPENBOT_MCP_DIR, allowNpx: e.OPENBOT_MCP_NPX_FALLBACK },
    role: e.OPENBOT_ROLE,
    metricsToken: e.OPENBOT_METRICS_TOKEN,
    trustedProxies: e.TRUSTED_PROXIES,
    providerKeys: {
      anthropic: e.ANTHROPIC_API_KEY,
      openai: e.OPENAI_API_KEY,
      xai: e.XAI_API_KEY,
      google: e.GOOGLE_GENERATIVE_AI_API_KEY,
      ollamaBaseUrl: e.OLLAMA_BASE_URL,
    },
    oauth: {
      github: oauthClient(e.GITHUB_CLIENT_ID, e.GITHUB_CLIENT_SECRET),
      google: oauthClient(e.GOOGLE_CLIENT_ID, e.GOOGLE_CLIENT_SECRET),
    },
    limits: resolveLimits(limitOverrides),
    processLimits: resolveProcessLimits(processOverrides),
  };
}

function oauthClient(clientId?: string, clientSecret?: string): OAuthClient | undefined {
  return clientId && clientSecret ? { clientId, clientSecret } : undefined;
}

/** Every variable `loadConfig` reads. `.env.example` lists them all (env-example.test.ts). */
export const CONFIG_ENV_VARS: readonly string[] = Object.keys(envSchema.shape);
