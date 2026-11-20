import {
  DEFAULT_SANDBOX_IMAGE,
  DEFAULT_SPRITES_NAME_PREFIX,
  isEgressDomain,
  isSpriteNamePrefix,
  resolveSandboxNetwork,
  type SandboxNetwork,
} from '@openbots/computer';
import { DEFAULT_CATALOG_INSTALL_DIR, type CatalogInstall } from '@openbots/mcp';
import { isValidTimezone } from '@openbots/routines';
import {
  LIMIT_ENV_VARS,
  PROCESS_LIMIT_ENV_VARS,
  resolveLimits,
  resolveProcessLimits,
  type Limits,
  type ProcessLimits,
} from '@openbots/shared';
import { isIP } from 'node:net';
import { z } from 'zod';
import { isCidr } from './client-ip.js';
import { resolveSecretFiles } from './env-files.js';
import { parseMasterKey } from './secrets.js';
import type { S3StorageConfig } from './storage/s3.js';

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

/** Master keys being rotated out (plan 4.9): comma-separated, each like OPENBOTS_MASTER_KEY. */
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
  OPENBOTS_PUBLIC_URL: withDefault(z.url(), 'http://localhost:3000'),
  OPENBOTS_RELAY_URL: optional(z.url({ protocol: /^wss?$/ })),
  OPENBOTS_MASTER_KEY: masterKey,
  OPENBOTS_MASTER_KEY_PREVIOUS: withDefault(masterKeyList, ''),
  DATABASE_URL: z.string().min(1),
  OPENBOTS_DB_APP_PASSWORD: optional(
    z.string().regex(/^[A-Za-z0-9_-]{16,128}$/, 'use 16 to 128 letters, digits, - or _'),
  ),
  REDIS_URL: optional(z.string()),
  DOCKER_HOST: optional(z.string()),
  OPENBOTS_SANDBOX_IMAGE: withDefault(z.string(), DEFAULT_SANDBOX_IMAGE),
  // Checked together by resolveSandboxNetwork below.
  OPENBOTS_SANDBOX_NETWORK: optional(z.string()),
  OPENBOTS_SANDBOX_BRIDGE: optional(z.string()),
  OPENBOTS_SANDBOX_EGRESS_PROXY: optional(proxyUrl),
  OPENBOTS_SANDBOX_NO_PROXY: optional(z.string()),
  OPENBOTS_TIMEZONE: withDefault(
    z.string().refine(isValidTimezone, {
      message: 'must be an IANA timezone name, e.g. Europe/London',
    }),
    'UTC',
  ),
  OPENBOTS_COMPUTER_AGENT_URL: optional(z.url()),
  OPENBOTS_COMPUTER_AGENT_TOKEN: optional(z.string()),
  OPENBOTS_COMPUTER_AGENT_SHARED: withDefault(z.stringbool(), 'false'),
  // The sprites provider (the hosted service): one Fly Sprite per account.
  OPENBOTS_SPRITES_TOKEN: optional(z.string()),
  OPENBOTS_SPRITES_NAME_PREFIX: withDefault(
    z.string().refine(isSpriteNamePrefix, {
      message: 'must be a lower case letter, then up to 15 letters, digits or -',
    }),
    DEFAULT_SPRITES_NAME_PREFIX,
  ),
  OPENBOTS_SPRITES_PROVISION_DIR: optional(z.string()),
  OPENBOTS_SPRITES_EGRESS: optional(
    z
      .string()
      .transform((value) =>
        value
          .split(/[\s,]+/)
          .map((domain) => domain.trim().toLowerCase())
          .filter(Boolean),
      )
      .refine((domains) => domains.every(isEgressDomain), {
        message: 'must be domains (example.com, *.example.com or *), separated by commas',
      }),
  ),
  OPENBOTS_SPRITES_URL_AUTH: withDefault(z.enum(['public', 'sprite']), 'public'),
  OPENBOTS_DEPLOYMENT: withDefault(z.enum(['self_hosted', 'managed']), 'self_hosted'),
  // Set by the standalone image (docker/standalone.Dockerfile), not by hand.
  OPENBOTS_STANDALONE: withDefault(z.stringbool(), 'false'),
  OPENBOTS_SETUP_PAIRING_ONLY: withDefault(z.stringbool(), 'false'),
  OPENBOTS_LOCAL_TOKEN: optional(
    z.string().min(32, { message: 'must be 32 characters or more (the Mac app generates one)' }),
  ),
  OPENBOTS_LOCAL_ENDPOINTS: optional(z.stringbool()),
  OPENBOTS_CUSTOM_STDIO: optional(z.stringbool()),
  OPENBOTS_FOLDER_CONNECTORS: optional(z.stringbool()),
  OPENBOTS_STDIO_RUNNER: optional(z.enum(['host', 'computer'])),
  OPENBOTS_ALLOW_HOST_STDIO: withDefault(z.stringbool(), 'false'),
  OPENBOTS_SIGNUP_MODE: withDefault(
    z.enum(['first_user_admin', 'invite', 'open']),
    'first_user_admin',
  ),
  OPENBOTS_FILES_DIR: withDefault(z.string(), '/data/files'),
  // Where stored files live (storage/index.ts). Checked together by storageFrom below.
  OPENBOTS_STORAGE_DRIVER: withDefault(z.enum(['local', 's3']), 'local'),
  OPENBOTS_S3_BUCKET: optional(
    z
      .string()
      .refine(
        (name) =>
          /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(name) &&
          !/\.\.|\.-|-\./.test(name) &&
          !/^\d+\.\d+\.\d+\.\d+$/.test(name),
        {
          message:
            'must be a bucket name: 3 to 63 lower case letters, digits, dots and hyphens, with no dot next to another dot or a hyphen, and not shaped like an IP address',
        },
      ),
  ),
  OPENBOTS_S3_ENDPOINT: optional(z.url({ protocol: /^https?$/ })),
  OPENBOTS_S3_REGION: optional(
    z
      .string()
      .regex(/^[a-z0-9-]{1,32}$/, { message: 'must be a region such as auto or us-east-1' }),
  ),
  OPENBOTS_S3_ACCESS_KEY_ID: optional(z.string()),
  OPENBOTS_S3_SECRET_ACCESS_KEY: optional(z.string()),
  OPENBOTS_S3_PREFIX: optional(
    z
      .string()
      .transform((value) => value.replace(/\/+$/, ''))
      .refine((value) => /^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*$/.test(value), {
        message: 'must be path segments of letters, digits, _ and -, such as openbots/prod',
      }),
  ),
  OPENBOTS_S3_PATH_STYLE: optional(z.stringbool()),
  OPENBOTS_ARTIFACT_DOMAIN: optional(
    z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^(?=.{4,200}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/, {
        message: 'must be a domain name such as openbots-artifacts.example, with no scheme or path',
      }),
  ),
  OPENBOTS_ARTIFACT_EDGE_SECRET: optional(
    z.string().min(32, { message: 'must be 32 characters or more (generate one with keygen)' }),
  ),
  OPENBOTS_MCP_DIR: withDefault(z.string(), DEFAULT_CATALOG_INSTALL_DIR),
  OPENBOTS_MCP_NPX_FALLBACK: withDefault(z.stringbool(), 'false'),
  OPENBOTS_ROLE: withDefault(z.enum(['api', 'worker', 'all']), 'all'),
  OPENBOTS_METRICS_TOKEN: optional(z.string().min(16)),
  TRUSTED_PROXIES: withDefault(cidrList, ''),
  OPENBOTS_CLIENT_IP_HEADER: optional(
    z
      .string()
      .regex(/^[A-Za-z0-9-]+$/, { message: 'must be a header name, such as fly-client-ip' })
      .transform((name) => name.toLowerCase()),
  ),
  ANTHROPIC_API_KEY: optional(z.string()),
  OPENAI_API_KEY: optional(z.string()),
  XAI_API_KEY: optional(z.string()),
  GOOGLE_GENERATIVE_AI_API_KEY: optional(z.string()),
  OLLAMA_BASE_URL: optional(z.url()),
  OPENBOTS_GITHUB_CLIENT_ID: optional(z.string()),
  OPENBOTS_GITHUB_APP_SLUG: optional(
    z
      .string()
      .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/)
      .max(100),
  ),
  GITHUB_CLIENT_ID: optional(z.string()),
  GITHUB_CLIENT_SECRET: optional(z.string()),
  GOOGLE_CLIENT_ID: optional(z.string()),
  GOOGLE_CLIENT_SECRET: optional(z.string()),
  // The managed service's shared GitHub App (GH1, I17). Checked together below.
  GITHUB_APP_ID: optional(z.string().regex(/^\d{1,20}$/, 'must be the App ID, digits')),
  GITHUB_APP_SLUG: optional(
    z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/, "must be the App's slug, as in its URL"),
  ),
  GITHUB_APP_PRIVATE_KEY: optional(
    z
      .string()
      // One line in .env, with \n for each line break.
      .transform((pem) => pem.replace(/\\n/g, '\n').trim())
      .refine(
        (pem) =>
          /^-----BEGIN (RSA )?PRIVATE KEY-----\n[\s\S]+\n-----END (RSA )?PRIVATE KEY-----$/.test(
            pem,
          ),
        {
          message: 'must be the PEM private key GitHub generated for the App',
        },
      ),
  ),
  GITHUB_APP_CLIENT_ID: optional(z.string()),
  GITHUB_APP_CLIENT_SECRET: optional(z.string()),
  GITHUB_APP_WEBHOOK_SECRET: optional(z.string().min(16)),
  ...limitsShape,
});

export type Deployment = 'self_hosted' | 'managed';
export type StorageConfig = { driver: 'local' } | S3StorageConfig;
export type StdioRunner = 'host' | 'computer';

export interface OAuthClient {
  clientId: string;
  clientSecret: string;
}

/**
 * A GitHub App's credentials (I17): the managed service's shared App from
 * GITHUB_APP_*, or (stored in `instance_settings`, not here) the one a
 * self-hoster made through the manifest flow.
 */
export interface GithubAppConfig {
  appId: string;
  slug: string;
  /** PEM; signs the JWT that mints installation tokens. */
  privateKey: string;
  /** For "Act as me" (GH8): the App's own OAuth sign-in. Both or neither. */
  clientId?: string;
  clientSecret?: string;
  webhookSecret: string;
}

export interface Config {
  publicUrl: string;
  /**
   * The private relay phones reach this server through (OPENBOTS_RELAY_URL,
   * a wss:// or ws:// URL; docs/RELAY_PROTOCOL.md). The server dials it only
   * once a device is paired or a pairing is open. Unset: no relay, and a
   * pairing link lists only direct addresses.
   */
  relayUrl?: string;
  /** Base64; seals every new secret. Open secrets with `keyringFromConfig`. */
  masterKey: string;
  /**
   * Base64 keys being rotated out (OPENBOTS_MASTER_KEY_PREVIOUS): they still
   * open secrets sealed under them until `rotate-key` re-seals those.
   */
  previousMasterKeys: string[];
  /** Secrets given in the plain environment rather than as NAME_FILE (S-1); main.ts warns. */
  secretsFromEnvironment: string[];
  databaseUrl: string;
  /**
   * OPENBOTS_DB_APP_PASSWORD: the app connects as openbots_app with it, a role
   * that owns nothing and does not bypass row-level security (db/app-role.ts).
   * Without it the app connects as DATABASE_URL's user and switches to that
   * role in every transaction.
   */
  dbAppPassword?: string;
  redisUrl?: string;
  dockerHost?: string;
  sandboxImage: string;
  /**
   * The network computers are created on and its bridge
   * (OPENBOTS_SANDBOX_NETWORK, OPENBOTS_SANDBOX_BRIDGE): compose's sandbox
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
   * The `sprites` computer provider (OPENBOTS_SPRITES_TOKEN; the hosted
   * service): one Fly Sprite per account, made and provisioned through the
   * Sprites API. Used when set and `computerAgent` is not, before Docker.
   * `provisionDir` holds provision.sh, agent-bundle.tgz and VERSION
   * (docker/sprites/); `egress` adds domains to the default allowlist;
   * `urlAuth` is how the server reaches the agent (packages/computer/src/sprites.ts).
   */
  sprites?: {
    token: string;
    namePrefix: string;
    provisionDir: string;
    egress: string[];
    urlAuth: 'public' | 'sprite';
  };
  /**
   * What kind of install this is (OPENBOTS_DEPLOYMENT). `self_hosted`, the
   * default, is a personal install with one account, its owner: sign-up
   * closes once it exists, and the members, invites and audit log routes
   * answer 404. `managed` is the hosted OpenBots service, where admins
   * manage members.
   */
  deployment: Deployment;
  /**
   * The Mac app's local owner token (OPENBOTS_LOCAL_TOKEN), self-hosted only.
   * With it the Mac app that runs this stack signs its owner in through
   * `POST /api/v1/local/session` instead of a password: the install has no
   * sign-in, sign-up or sign-out. Only the app's main process holds it.
   */
  localToken?: string;
  /**
   * The first owner is made by pairing a phone only
   * (OPENBOTS_SETUP_PAIRING_ONLY; the standalone image sets it): the web
   * wizard's account step and the email sign-up refuse with 403
   * SETUP_PAIRING_ONLY while there is no owner, so nobody who finds the port
   * first claims the install. `openbots pair` prints the link that makes the
   * owner. Self-hosted only.
   */
  setupPairingOnly: boolean;
  /**
   * Who may sign up on the managed service (plan 21.6): `open` lets anyone
   * sign up and make an organization; `invite` and `first_user_admin` (its
   * old name) let only the first user and people with a pending invitation.
   * Self-hosted is always closed after its owner.
   */
  signupMode: 'first_user_admin' | 'invite' | 'open';
  /**
   * Whether admins may mark a provider, connector or event subscription as
   * on their own network, so it may reach private addresses (S-8,
   * OPENBOTS_LOCAL_ENDPOINTS). On by default for a self-hosted install; off by
   * default on the managed service, whose network every organization shares.
   */
  localEndpoints: boolean;
  /**
   * Whether an organization's admins may turn custom stdio connectors on at
   * all (S-1, OPENBOTS_CUSTOM_STDIO): each runs a command on the server. On by
   * default for a self-hosted install; off by default on the managed
   * service, whose server every organization shares.
   */
  customStdio: boolean;
  /**
   * Whether folder (filesystem) connectors may be added and run. Always on
   * with the `computer` stdio runner: each runs in its owner's computer
   * and serves a folder there. With the `host` runner each serves a folder
   * on this server's disk, under `<filesDir>/connectors/`, which one
   * machine of several does not share, so OPENBOTS_FOLDER_CONNECTORS
   * decides: on by default for a self-hosted install, off by default for a
   * managed one (which runs host stdio only with OPENBOTS_ALLOW_HOST_STDIO,
   * every organization's on one server). Off, adding one is refused and
   * one that exists does not run and reads as unavailable.
   */
  folderConnectors: boolean;
  /**
   * Where stdio connectors run (OPENBOTS_STDIO_RUNNER). `host`, the default
   * for a self-hosted install, runs them as child processes of this server,
   * as an unprivileged user. `computer`, the default on the managed service,
   * runs each in its owner's computer for that organization, so no two
   * accounts or organizations share a process or a filesystem. The managed
   * service refuses `host` unless the operator sets
   * OPENBOTS_ALLOW_HOST_STDIO, and then warns at every start.
   */
  stdioRunner: StdioRunner;
  /**
   * OPENBOTS_FILES_DIR: uploads, Artifact blobs and coding session logs
   * (`coders/`) with the local storage driver; with s3, only the spools of
   * session logs this machine has not stored yet (services/coder-log.ts).
   * Folder connectors' folders (`connectors/`) are here with either driver
   * when they run on this server (the `host` stdio runner).
   */
  filesDir: string;
  /**
   * Where stored files' bytes live (OPENBOTS_STORAGE_DRIVER, storage/index.ts):
   * `local`, the default, is `filesDir`; `s3` is an S3-compatible bucket
   * (OPENBOTS_S3_*), for several machines sharing one store.
   */
  storage: StorageConfig;
  /**
   * The artifact host (plan 21.11; OPENBOTS_ARTIFACT_DOMAIN): Artifacts a
   * person shared are served at `https://<bot>--<organization>.<domain>/<id>`,
   * a registrable domain apart from the app's, so their content never shares
   * an origin or a cookie with it. Unset: sharing is off and nothing about
   * Artifacts changes. `edgeSecret` (OPENBOTS_ARTIFACT_EDGE_SECRET) is what
   * the edge Worker in front of it sends to `/artifact-host/`; without it that
   * path answers 404 and only requests that reach this server under the
   * domain itself are served.
   */
  artifactHost?: { domain: string; edgeSecret?: string };
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
  /**
   * A header a trusted proxy sets to the client's address, read instead of
   * X-Forwarded-For (OPENBOTS_CLIENT_IP_HEADER, such as `fly-client-ip`),
   * lower case. Believed only from one of `trustedProxies`.
   */
  clientIpHeader?: string;
  providerKeys: {
    anthropic?: string;
    openai?: string;
    xai?: string;
    google?: string;
    ollamaBaseUrl?: string;
  };
  /** Public GitHub App identifiers for repository installation and device authorization. */
  githubConnectorClientId?: string;
  githubConnectorAppSlug?: string;
  /** Sign-in providers (U1), each enabled only when both its id and secret are set. */
  oauth: {
    github?: OAuthClient;
    google?: OAuthClient;
  };
  /**
   * The managed service's shared GitHub App, when GITHUB_APP_ID, _SLUG,
   * _PRIVATE_KEY and _WEBHOOK_SECRET are all set. A self-hosted install gets
   * its own App through the manifest flow instead.
   */
  githubApp?: GithubAppConfig;
  limits: Limits;
  /**
   * Approval expiry, the MCP idle stop and the web_fetch caps
   * (OPENBOTS_APPROVAL_TTL_MINUTES and so on): set at start, not admin settings.
   */
  processLimits: ProcessLimits;
}

/** Set these public identifiers after creating the shared GitHub App. Never put secrets here. */
export const DEFAULT_GITHUB_CONNECTOR_CLIENT_ID = 'Iv23liyL74CRKUWIUXhq';
export const DEFAULT_GITHUB_CONNECTOR_APP_SLUG = 'openbots-github';

/**
 * What the server warns about at start in how storage is set up, or null.
 * The s3 driver is for a server on several machines, but folder connectors
 * that run on the server (the `host` stdio runner) keep their folders on
 * one machine's disk (`<filesDir>/connectors/`), so a folder made on one is
 * missing on the others. With the `computer` runner a folder is in its
 * owner's computer, which every machine reaches. Names the settings only.
 */
export function storageWarning(
  config: Pick<Config, 'storage' | 'folderConnectors' | 'stdioRunner'>,
): string | null {
  if (config.storage.driver !== 's3' || config.stdioRunner !== 'host' || !config.folderConnectors)
    return null;
  return "OPENBOTS_STORAGE_DRIVER=s3 with folder connectors on the server (OPENBOTS_STDIO_RUNNER=host, OPENBOTS_FOLDER_CONNECTORS): their folders stay on each machine's own disk, so on several machines a connector finds a different folder, or none; set OPENBOTS_FOLDER_CONNECTORS=false, or run stdio connectors in computers (OPENBOTS_STDIO_RUNNER=computer)";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const secrets = resolveSecretFiles(env);
  const parsed = envSchema.safeParse(secrets.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`invalid configuration:\n${issues.join('\n')}`);
  }
  const e = parsed.data;
  if (e.OPENBOTS_MASTER_KEY_PREVIOUS.includes(e.OPENBOTS_MASTER_KEY.trim())) {
    throw new Error(
      'invalid configuration:\n  OPENBOTS_MASTER_KEY_PREVIOUS: holds OPENBOTS_MASTER_KEY itself; list only the keys being replaced',
    );
  }
  // The standalone image runs one person's OpenBots, database and computer in
  // one container (V6): it is never the managed service.
  if (e.OPENBOTS_STANDALONE && e.OPENBOTS_DEPLOYMENT === 'managed') {
    throw new Error(
      'invalid configuration:\n  OPENBOTS_DEPLOYMENT: the standalone image is a single-person install and runs self_hosted only; unset OPENBOTS_DEPLOYMENT or set it to self_hosted',
    );
  }
  // A Sprite without the provisioning has no control agent to answer.
  if (e.OPENBOTS_SPRITES_TOKEN && !e.OPENBOTS_SPRITES_PROVISION_DIR) {
    throw new Error(
      'invalid configuration:\n  OPENBOTS_SPRITES_PROVISION_DIR: needed with OPENBOTS_SPRITES_TOKEN, the directory holding provision.sh, agent-bundle.tgz and VERSION',
    );
  }
  if (e.OPENBOTS_LOCAL_TOKEN && e.OPENBOTS_DEPLOYMENT !== 'self_hosted') {
    throw new Error(
      'invalid configuration:\n  OPENBOTS_LOCAL_TOKEN: only a self-hosted install signs in with the Mac app; unset it for managed',
    );
  }
  const stdioRunner =
    e.OPENBOTS_STDIO_RUNNER ?? (e.OPENBOTS_DEPLOYMENT === 'managed' ? 'computer' : 'host');
  if (
    e.OPENBOTS_DEPLOYMENT === 'managed' &&
    stdioRunner === 'host' &&
    !e.OPENBOTS_ALLOW_HOST_STDIO
  ) {
    throw new Error(
      "invalid configuration:\n  OPENBOTS_STDIO_RUNNER: host would run every organization's stdio connectors on this one server; use computer, or set OPENBOTS_ALLOW_HOST_STDIO=1 to accept that",
    );
  }
  let sandboxNetwork: SandboxNetwork;
  try {
    sandboxNetwork = resolveSandboxNetwork(e.OPENBOTS_SANDBOX_NETWORK, e.OPENBOTS_SANDBOX_BRIDGE);
  } catch (error) {
    throw new Error(`invalid configuration:\n  ${(error as Error).message}`, { cause: error });
  }
  const githubApp = githubAppFrom(e);
  const artifactHost = artifactHostFrom(e);
  const storage = storageFrom(e);
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
    publicUrl: e.OPENBOTS_PUBLIC_URL,
    ...(e.OPENBOTS_RELAY_URL ? { relayUrl: e.OPENBOTS_RELAY_URL.replace(/\/+$/, '') } : {}),
    masterKey: e.OPENBOTS_MASTER_KEY,
    previousMasterKeys: e.OPENBOTS_MASTER_KEY_PREVIOUS,
    secretsFromEnvironment: secrets.fromEnvironment,
    databaseUrl: e.DATABASE_URL,
    ...(e.OPENBOTS_DB_APP_PASSWORD ? { dbAppPassword: e.OPENBOTS_DB_APP_PASSWORD } : {}),
    redisUrl: e.REDIS_URL,
    dockerHost: e.DOCKER_HOST,
    sandboxImage: e.OPENBOTS_SANDBOX_IMAGE,
    sandboxNetwork,
    sandboxProxy: e.OPENBOTS_SANDBOX_EGRESS_PROXY
      ? { url: e.OPENBOTS_SANDBOX_EGRESS_PROXY, noProxy: e.OPENBOTS_SANDBOX_NO_PROXY }
      : undefined,
    timezone: e.OPENBOTS_TIMEZONE,
    computerAgent: e.OPENBOTS_COMPUTER_AGENT_URL
      ? {
          url: e.OPENBOTS_COMPUTER_AGENT_URL,
          token: e.OPENBOTS_COMPUTER_AGENT_TOKEN ?? '',
          shared: e.OPENBOTS_COMPUTER_AGENT_SHARED,
        }
      : undefined,
    sprites: e.OPENBOTS_SPRITES_TOKEN
      ? {
          token: e.OPENBOTS_SPRITES_TOKEN,
          namePrefix: e.OPENBOTS_SPRITES_NAME_PREFIX,
          provisionDir: e.OPENBOTS_SPRITES_PROVISION_DIR ?? '',
          egress: e.OPENBOTS_SPRITES_EGRESS ?? [],
          urlAuth: e.OPENBOTS_SPRITES_URL_AUTH,
        }
      : undefined,
    deployment: e.OPENBOTS_DEPLOYMENT,
    localToken: e.OPENBOTS_LOCAL_TOKEN,
    setupPairingOnly: e.OPENBOTS_SETUP_PAIRING_ONLY && e.OPENBOTS_DEPLOYMENT === 'self_hosted',
    signupMode: e.OPENBOTS_SIGNUP_MODE,
    localEndpoints: e.OPENBOTS_LOCAL_ENDPOINTS ?? e.OPENBOTS_DEPLOYMENT === 'self_hosted',
    customStdio: e.OPENBOTS_CUSTOM_STDIO ?? e.OPENBOTS_DEPLOYMENT === 'self_hosted',
    // In the computer a folder is the member's own; on the server, the setting decides.
    folderConnectors:
      stdioRunner === 'computer' ||
      (e.OPENBOTS_FOLDER_CONNECTORS ?? e.OPENBOTS_DEPLOYMENT === 'self_hosted'),
    stdioRunner,
    filesDir: e.OPENBOTS_FILES_DIR,
    storage,
    ...(artifactHost ? { artifactHost } : {}),
    mcpCatalog: { dir: e.OPENBOTS_MCP_DIR, allowNpx: e.OPENBOTS_MCP_NPX_FALLBACK },
    role: e.OPENBOTS_ROLE,
    metricsToken: e.OPENBOTS_METRICS_TOKEN,
    trustedProxies: e.TRUSTED_PROXIES,
    ...(e.OPENBOTS_CLIENT_IP_HEADER ? { clientIpHeader: e.OPENBOTS_CLIENT_IP_HEADER } : {}),
    providerKeys: {
      anthropic: e.ANTHROPIC_API_KEY,
      openai: e.OPENAI_API_KEY,
      xai: e.XAI_API_KEY,
      google: e.GOOGLE_GENERATIVE_AI_API_KEY,
      ollamaBaseUrl: e.OLLAMA_BASE_URL,
    },
    githubConnectorClientId:
      e.OPENBOTS_GITHUB_CLIENT_ID || DEFAULT_GITHUB_CONNECTOR_CLIENT_ID || undefined,
    // An overridden client must never inherit another app's installation URL.
    githubConnectorAppSlug: e.OPENBOTS_GITHUB_CLIENT_ID
      ? e.OPENBOTS_GITHUB_APP_SLUG
      : e.OPENBOTS_GITHUB_APP_SLUG || DEFAULT_GITHUB_CONNECTOR_APP_SLUG || undefined,
    oauth: {
      github: oauthClient(e.GITHUB_CLIENT_ID, e.GITHUB_CLIENT_SECRET),
      google: oauthClient(e.GOOGLE_CLIENT_ID, e.GOOGLE_CLIENT_SECRET),
    },
    ...(githubApp ? { githubApp } : {}),
    limits: resolveLimits(limitOverrides),
    processLimits: resolveProcessLimits(processOverrides),
  };
}

/**
 * The artifact domain must not be the app's host or hold it, nor sit under
 * it: an Artifact's page would then share the app's cookies or origin. A
 * different registrable domain is what the docs ask for; this catches the
 * mistakes a configuration can show without a public suffix list.
 */
function artifactHostFrom(e: z.infer<typeof envSchema>): Config['artifactHost'] {
  if (!e.OPENBOTS_ARTIFACT_DOMAIN) {
    if (e.OPENBOTS_ARTIFACT_EDGE_SECRET) {
      throw new Error(
        'invalid configuration:\n  OPENBOTS_ARTIFACT_EDGE_SECRET: set only with OPENBOTS_ARTIFACT_DOMAIN',
      );
    }
    return undefined;
  }
  const domain = e.OPENBOTS_ARTIFACT_DOMAIN;
  const app = new URL(e.OPENBOTS_PUBLIC_URL).hostname.toLowerCase();
  if (app === domain || app.endsWith(`.${domain}`) || domain.endsWith(`.${app}`)) {
    throw new Error(
      `invalid configuration:\n  OPENBOTS_ARTIFACT_DOMAIN: must be a domain apart from the app's (${app}), so shared pages never reach its cookies`,
    );
  }
  return {
    domain,
    ...(e.OPENBOTS_ARTIFACT_EDGE_SECRET ? { edgeSecret: e.OPENBOTS_ARTIFACT_EDGE_SECRET } : {}),
  };
}

const S3_SETTINGS = [
  'OPENBOTS_S3_BUCKET',
  'OPENBOTS_S3_ENDPOINT',
  'OPENBOTS_S3_REGION',
  'OPENBOTS_S3_ACCESS_KEY_ID',
  'OPENBOTS_S3_SECRET_ACCESS_KEY',
  'OPENBOTS_S3_PREFIX',
  'OPENBOTS_S3_PATH_STYLE',
] as const;

/**
 * The storage driver. `s3` needs a bucket, both keys, and an endpoint or a
 * region: R2 and MinIO give an endpoint (the region is then `auto` unless
 * set), AWS a region (the endpoint is then its own). The S3 settings apply
 * only to `s3`, so one set without it is refused rather than ignored. The
 * messages name settings, never their values.
 */
function storageFrom(e: z.infer<typeof envSchema>): StorageConfig {
  if (e.OPENBOTS_STORAGE_DRIVER === 'local') {
    const stray = S3_SETTINGS.filter((name) => e[name] !== undefined);
    if (stray.length) {
      throw new Error(
        `invalid configuration:\n${stray.map((name) => `  ${name}: set only with OPENBOTS_STORAGE_DRIVER=s3`).join('\n')}`,
      );
    }
    return { driver: 'local' };
  }
  const problems: string[] = [];
  if (!e.OPENBOTS_S3_BUCKET)
    problems.push('  OPENBOTS_S3_BUCKET: needed with OPENBOTS_STORAGE_DRIVER=s3');
  if (!e.OPENBOTS_S3_ACCESS_KEY_ID) {
    problems.push('  OPENBOTS_S3_ACCESS_KEY_ID: needed with OPENBOTS_STORAGE_DRIVER=s3');
  }
  if (!e.OPENBOTS_S3_SECRET_ACCESS_KEY) {
    problems.push('  OPENBOTS_S3_SECRET_ACCESS_KEY: needed with OPENBOTS_STORAGE_DRIVER=s3');
  }
  if (!e.OPENBOTS_S3_ENDPOINT && !e.OPENBOTS_S3_REGION) {
    problems.push(
      '  OPENBOTS_S3_ENDPOINT: needed with OPENBOTS_STORAGE_DRIVER=s3, unless OPENBOTS_S3_REGION names an AWS region',
    );
  }
  if (!e.OPENBOTS_S3_ENDPOINT && e.OPENBOTS_S3_REGION === 'auto') {
    problems.push(
      "  OPENBOTS_S3_REGION: auto needs OPENBOTS_S3_ENDPOINT (R2, MinIO); for AWS, name the bucket's region",
    );
  }
  if (e.OPENBOTS_S3_ENDPOINT) {
    const url = new URL(e.OPENBOTS_S3_ENDPOINT);
    if (url.username || url.password || url.search || url.hash) {
      problems.push(
        "  OPENBOTS_S3_ENDPOINT: must be the service's address alone, with no user name, password, query or fragment (the keys go in OPENBOTS_S3_ACCESS_KEY_ID and OPENBOTS_S3_SECRET_ACCESS_KEY)",
      );
    } else if (url.protocol === 'http:' && !onThisNetwork(url.hostname)) {
      problems.push(
        '  OPENBOTS_S3_ENDPOINT: use https; plain http is taken only for this machine, a single label name such as a compose service, or a private address',
      );
    }
  }
  if (problems.length) throw new Error(`invalid configuration:\n${problems.join('\n')}`);
  const region = e.OPENBOTS_S3_REGION ?? 'auto';
  const endpoint = e.OPENBOTS_S3_ENDPOINT ?? `https://s3.${region}.amazonaws.com`;
  // An endpoint of one's own (R2, MinIO) is addressed by path; AWS by bucket hostname.
  const pathStyle = e.OPENBOTS_S3_PATH_STYLE ?? !!e.OPENBOTS_S3_ENDPOINT;
  // <bucket>.<host> with a dot in the bucket is not covered by the host's wildcard certificate.
  if (!pathStyle && e.OPENBOTS_S3_BUCKET!.includes('.') && endpoint.startsWith('https:')) {
    throw new Error(
      'invalid configuration:\n  OPENBOTS_S3_BUCKET: a name with dots cannot be reached by bucket hostname over https; set OPENBOTS_S3_PATH_STYLE=true or use a name without dots',
    );
  }
  return {
    driver: 's3',
    bucket: e.OPENBOTS_S3_BUCKET!,
    endpoint,
    region,
    accessKeyId: e.OPENBOTS_S3_ACCESS_KEY_ID!,
    secretAccessKey: e.OPENBOTS_S3_SECRET_ACCESS_KEY!,
    prefix: e.OPENBOTS_S3_PREFIX ? `${e.OPENBOTS_S3_PREFIX}/` : '',
    pathStyle,
  };
}

/**
 * Whether a plain http endpoint stays off the public internet: this machine
 * (loopback), a single label name (a compose service such as `minio`), or a
 * private address literal (10/8, 172.16/12, 192.168/16, fc00::/7).
 */
function onThisNetwork(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const family = isIP(host);
  if (family === 4) {
    const [a, b] = host.split('.').map(Number) as [number, number];
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (family === 6) return host === '::1' || /^f[cd][0-9a-f]{0,2}:/.test(host);
  return host === 'localhost' || !host.includes('.');
}

const GITHUB_APP_REQUIRED = [
  'GITHUB_APP_ID',
  'GITHUB_APP_SLUG',
  'GITHUB_APP_PRIVATE_KEY',
  'GITHUB_APP_WEBHOOK_SECRET',
] as const;

/** The shared App: all of its required variables or none, and its OAuth client whole or not at all. */
function githubAppFrom(e: z.infer<typeof envSchema>): GithubAppConfig | undefined {
  const missing = GITHUB_APP_REQUIRED.filter((name) => !e[name]);
  const oauthHalf = !e.GITHUB_APP_CLIENT_ID !== !e.GITHUB_APP_CLIENT_SECRET;
  if (missing.length === GITHUB_APP_REQUIRED.length) {
    if (e.GITHUB_APP_CLIENT_ID || e.GITHUB_APP_CLIENT_SECRET) {
      throw new Error(
        'invalid configuration:\n  GITHUB_APP_CLIENT_ID: set only with GITHUB_APP_ID, GITHUB_APP_SLUG, GITHUB_APP_PRIVATE_KEY and GITHUB_APP_WEBHOOK_SECRET',
      );
    }
    return undefined;
  }
  const problems = missing.map((name) => `  ${name}: needed with the other GITHUB_APP_ variables`);
  if (oauthHalf) {
    problems.push(
      '  GITHUB_APP_CLIENT_SECRET: set both GITHUB_APP_CLIENT_ID and GITHUB_APP_CLIENT_SECRET, or neither',
    );
  }
  if (problems.length) throw new Error(`invalid configuration:\n${problems.join('\n')}`);
  return {
    appId: e.GITHUB_APP_ID!,
    slug: e.GITHUB_APP_SLUG!,
    privateKey: e.GITHUB_APP_PRIVATE_KEY!,
    ...(e.GITHUB_APP_CLIENT_ID
      ? { clientId: e.GITHUB_APP_CLIENT_ID, clientSecret: e.GITHUB_APP_CLIENT_SECRET! }
      : {}),
    webhookSecret: e.GITHUB_APP_WEBHOOK_SECRET!,
  };
}

function oauthClient(clientId?: string, clientSecret?: string): OAuthClient | undefined {
  return clientId && clientSecret ? { clientId, clientSecret } : undefined;
}

/** Every variable `loadConfig` reads. `.env.example` lists them all (env-example.test.ts). */
export const CONFIG_ENV_VARS: readonly string[] = Object.keys(envSchema.shape);
