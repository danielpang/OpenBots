import {
  APIError,
  ExecError,
  FilesystemError,
  SpritesClient,
  type CheckpointStream,
  type RestoreStream,
  type Sprite,
} from '@fly/sprites';
import type { ComputerCheckpoint, EgressPolicy, EgressRule } from './types.js';

// The part of the Sprites API the sprites provider uses, behind a narrow
// interface so tests stand in a fake (`fakeSpritesApi` in testing.ts). The
// adapter below is the official SDK, @fly/sprites, with what the provider
// needs on top of it: a time limit on every call, a missing Sprite or file
// read as null, and every failure turned into a `SpritesApiError` whose text
// is our own plus at most 500 characters of the API's answer, never a token.
// That text is for the server's log: on the hosted service the owner reads
// `HOSTED_FAILURE` instead (apps/server/src/services/computer.ts).
//
// One endpoint is still called directly: setting the network policy. The
// SDK release in use (0.2.4) accepts only 204 there, while the API documents
// 200 with the stored policy and some Sprite runtimes answer that; 0.2.5
// fixes it. Move it to `sprite.updateNetworkPolicy` with that release.

/** `cold` and `warm` are paused; a request to the Sprite or the API wakes it. */
export type SpriteStatus = 'cold' | 'warm' | 'running' | (string & {});

/** Who may reach the Sprite's URL: members of the org with an org token, or anyone. */
export type SpriteUrlAuth = 'sprite' | 'public';

export interface SpriteInfo {
  name: string;
  /** `https://<name>-<org id>.sprites.app`, routed to the Sprite's HTTP port. */
  url: string;
  status: SpriteStatus;
  urlAuth?: SpriteUrlAuth;
}

/** The Sprites network policy has the shape of the provider's egress policy. */
export type SpriteEgressRule = EgressRule;
export type SpriteEgressPolicy = EgressPolicy;

export interface SpriteExecOptions {
  /** Passed in the URL's query string, so never a secret: send those on stdin. */
  env?: Record<string, string>;
  stdin?: Uint8Array | string;
  cwd?: string;
  timeoutMs?: number;
}

export interface SpriteExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type SpriteCheckpoint = ComputerCheckpoint;

export interface SpritesApi {
  create(name: string, options: { urlAuth: SpriteUrlAuth }): Promise<SpriteInfo>;
  /** Null when there is no such Sprite. */
  get(name: string): Promise<SpriteInfo | null>;
  /** A Sprite already gone is not an error. */
  delete(name: string): Promise<void>;
  setUrlAuth(name: string, auth: SpriteUrlAuth): Promise<void>;
  setNetworkPolicy(name: string, policy: SpriteEgressPolicy): Promise<void>;
  /** Runs `argv` (no shell) and waits for it; a non-zero exit is a result, not an error. */
  exec(name: string, argv: string[], options?: SpriteExecOptions): Promise<SpriteExecResult>;
  writeFile(
    name: string,
    path: string,
    data: Uint8Array,
    options?: { mode?: number },
  ): Promise<void>;
  /** Null when the file does not exist. */
  readFile(name: string, path: string): Promise<Uint8Array | null>;
  /** Resolves with the new checkpoint's id once it is saved. */
  createCheckpoint(name: string, comment?: string): Promise<string>;
  listCheckpoints(name: string): Promise<SpriteCheckpoint[]>;
  restoreCheckpoint(name: string, id: string): Promise<void>;
}

export class SpritesApiError extends Error {
  constructor(
    /** The API's HTTP status, or 0 when there was no answer (a timeout, the network). */
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'SpritesApiError';
  }
}

export const SPRITES_API_URL = 'https://api.sprites.dev';
/** The largest body `fs/write` takes (16 MiB). */
export const SPRITES_MAX_WRITE_BYTES = 16 * 1024 * 1024;

export interface SpritesApiOptions {
  /** A Sprites org token (`sprite auth setup --token`, or the dashboard). */
  token: string;
  baseUrl?: string;
  /** Time limit for each call but `create`, `exec`, file writes and checkpoints. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const CREATE_TIMEOUT_MS = 2 * 60_000;
const DEFAULT_EXEC_TIMEOUT_MS = 10 * 60_000;
const WRITE_TIMEOUT_MS = 5 * 60_000;
/** Checkpoints take 10 to 30 seconds by the docs; restores are similar. */
const CHECKPOINT_TIMEOUT_MS = 10 * 60_000;
/** How much of the API's own answer an error keeps. */
const UPSTREAM_TEXT_LIMIT = 500;

export function createSpritesApi({
  token,
  baseUrl = SPRITES_API_URL,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: SpritesApiOptions): SpritesApi {
  const base = baseUrl.replace(/\/+$/, '');
  // The SDK's own limit covers get, delete and the URL settings; its create
  // has a fixed two minutes. Everything else is limited here.
  const client = new SpritesClient(token, { baseURL: base, timeout: timeoutMs });
  const sprite = (name: string) => client.sprite(name);
  /** Never let the org token into an error, whatever the SDK put there. */
  const redact = (text: string) => (token ? text.split(token).join('[token]') : text);
  const fail = (what: string, error: unknown) => {
    if (error instanceof SpritesApiError) return error;
    const status = statusOf(error);
    const detail = redact(upstreamText(error));
    return new SpritesApiError(
      status,
      `Sprites API: ${what} failed${status ? ` (${status})` : ''}${detail ? `: ${detail}` : ''}`,
    );
  };
  /** Runs one SDK call within `ms`, and maps what it throws. */
  async function call<T>(what: string, ms: number, run: () => Promise<T>): Promise<T> {
    try {
      return await within(ms, what, run());
    } catch (error) {
      throw fail(what, error);
    }
  }

  return {
    async create(name, { urlAuth }) {
      const made = await call('create', CREATE_TIMEOUT_MS, () =>
        client.createSprite(name, { urlSettings: { auth: urlAuth } }),
      );
      return info(made);
    },
    async get(name) {
      try {
        return info(await within(timeoutMs, 'get', client.getSprite(name)));
      } catch (error) {
        if (statusOf(error) === 404) return null;
        throw fail('get', error);
      }
    },
    async delete(name) {
      try {
        await within(timeoutMs, 'delete', client.deleteSprite(name));
      } catch (error) {
        if (statusOf(error) === 404) return;
        throw fail('delete', error);
      }
    },
    async setUrlAuth(name, auth) {
      await call('URL settings', timeoutMs, () => client.updateURLSettings(name, { auth }));
    },
    // Raw: see the header. The same endpoint and body the SDK sends.
    async setNetworkPolicy(name, policy) {
      await call('network policy', timeoutMs, async () => {
        const response = await fetch(
          `${base}/v1/sprites/${encodeURIComponent(name)}/policy/network`,
          {
            method: 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: JSON.stringify({ rules: policy.rules }),
            signal: AbortSignal.timeout(timeoutMs),
          },
        );
        if (!response.ok) {
          const text = await response.text().catch(() => '');
          throw new SpritesApiError(
            response.status,
            `Sprites API: network policy failed (${response.status})${
              text.trim() ? `: ${redact(clip(text))}` : ''
            }`,
          );
        }
        await response.body?.cancel();
      });
    },
    async exec(name, argv, options = {}) {
      if (argv.length === 0) throw new Error('exec needs a command');
      try {
        return await run(sprite(name), argv, options);
      } catch (error) {
        throw fail('exec', error);
      }
    },
    async writeFile(name, path, data, options = {}) {
      if (data.byteLength > SPRITES_MAX_WRITE_BYTES) {
        throw new Error(`fs/write takes at most ${SPRITES_MAX_WRITE_BYTES} bytes`);
      }
      await call('file write', WRITE_TIMEOUT_MS, () =>
        sprite(name)
          .filesystem('/')
          .writeFile(path, Buffer.from(data.buffer, data.byteOffset, data.byteLength), options),
      );
    },
    async readFile(name, path) {
      try {
        const data = await within(
          timeoutMs,
          'file read',
          sprite(name).filesystem('/').readFile(path, null),
        );
        return new Uint8Array(data);
      } catch (error) {
        if (error instanceof FilesystemError && error.code === 'ENOENT') return null;
        throw fail('file read', error);
      }
    },
    async createCheckpoint(name, comment) {
      const done = await call('checkpoint', CHECKPOINT_TIMEOUT_MS, async () =>
        finish(await sprite(name).createCheckpoint(comment), 'checkpoint'),
      );
      // "Checkpoint v8 created": the id is in the completion message. If a
      // later API words it otherwise, the newest checkpoint is the one made.
      const id = /\b(v\d+)\b/.exec(done ?? '')?.[1];
      if (id) return id;
      const [newest] = (await this.listCheckpoints(name)).sort((a, b) =>
        b.createdAt.localeCompare(a.createdAt),
      );
      if (!newest) throw new SpritesApiError(0, 'The checkpoint was made but is not listed');
      return newest.id;
    },
    async listCheckpoints(name) {
      const listed = await call('checkpoint list', timeoutMs, () => sprite(name).listCheckpoints());
      return listed.map((cp) => ({
        id: cp.id,
        createdAt: Number.isNaN(cp.createTime.getTime()) ? '' : cp.createTime.toISOString(),
        ...(cp.comment ? { comment: cp.comment } : {}),
      }));
    },
    async restoreCheckpoint(name, id) {
      await call('restore', CHECKPOINT_TIMEOUT_MS, async () => {
        await finish(await sprite(name).restoreCheckpoint(id), 'restore');
      });
    },
  };
}

function info(sprite: Sprite): SpriteInfo {
  const auth = sprite.urlSettings?.auth;
  return {
    name: sprite.name,
    url: sprite.url ?? '',
    status: sprite.status ?? '',
    ...(auth === 'sprite' || auth === 'public' ? { urlAuth: auth } : {}),
  };
}

/**
 * Reads a checkpoint or restore progress stream to its end. Throws on an
 * `error` event, or (the SDK does) when the stream ends without a final
 * event; resolves with the completion message. The stream is closed however
 * it ends, a time limit included.
 */
async function finish(
  stream: CheckpointStream | RestoreStream,
  what: string,
): Promise<string | undefined> {
  let complete: string | undefined;
  let sawComplete = false;
  try {
    for await (const event of stream) {
      if (event.type === 'error') {
        throw new SpritesApiError(0, `The ${what} failed: ${clip(event.error ?? 'error')}`);
      }
      if (event.type === 'complete') {
        sawComplete = true;
        complete = event.data;
      }
    }
  } finally {
    stream.close();
  }
  if (!sawComplete) throw new SpritesApiError(0, `The ${what} stream ended before it completed`);
  return complete;
}

/**
 * Runs `argv` through the SDK's WebSocket exec, whose messages keep stdout,
 * stderr and the exit code apart (the HTTP exec's chunks carry no length).
 * stdin is written once the command has started, then closed, so a command
 * that reads it never waits; without `stdin` it gets an empty one, as the
 * HTTP exec gave. A connection that closes without an exit code is an error.
 */
function run(
  sprite: Sprite,
  argv: string[],
  options: SpriteExecOptions,
): Promise<SpriteExecResult> {
  const [file, ...args] = argv as [string, ...string[]];
  const timeoutMs = options.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const command = sprite.spawn(file, args, {
      ...(options.env ? { env: options.env } : {}),
      ...(options.cwd ? { cwd: options.cwd } : {}),
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let exitCode: number | undefined;
    let outEnded = false;
    let errEnded = false;
    let settled = false;
    const settle = (error: unknown, result?: SpriteExecResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        command.close();
        reject(error);
      } else resolve(result!);
    };
    const timer = setTimeout(() => {
      command.kill();
      settle(new SpritesApiError(0, `exec timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    // Done once the exit code is in and both streams have ended (the SDK
    // ends them right after `exit`, so all their data is in by then).
    const done = () => {
      if (exitCode === undefined || !outEnded || !errEnded) return;
      if (exitCode < 0) {
        settle(new SpritesApiError(0, 'The exec ended without an exit code'));
        return;
      }
      const text = (parts: Buffer[]) => Buffer.concat(parts).toString('utf8');
      settle(null, { exitCode, stdout: text(out), stderr: text(err) });
    };
    command.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    command.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    command.stdout.on('end', () => {
      outEnded = true;
      done();
    });
    command.stderr.on('end', () => {
      errEnded = true;
      done();
    });
    command.on('exit', (code: number) => {
      exitCode = code;
      done();
    });
    command.on('error', (error: unknown) => settle(error));
    command.on('spawn', () => {
      try {
        if (options.stdin !== undefined) command.stdin.write(options.stdin);
        command.stdin.end();
      } catch (error) {
        settle(error);
      }
    });
  });
}

/** Resolves or rejects as `promise` does, or rejects once `ms` have passed. */
function within<T>(ms: number, what: string, promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new SpritesApiError(0, `Sprites API: ${what} timed out after ${ms} ms`)),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** The API's HTTP status in what the SDK threw, when it says. */
function statusOf(error: unknown): number {
  if (error instanceof SpritesApiError) return error.status;
  if (error instanceof APIError) return error.statusCode ?? 0;
  if (error instanceof FilesystemError) return error.code === 'ENOENT' ? 404 : 0;
  // Several SDK calls throw a plain Error worded `... (status 404): <body>`.
  const match = /\(status (\d{3})\)/.exec(error instanceof Error ? error.message : '');
  return match ? Number(match[1]) : 0;
}

/** What the SDK's error says, clipped, for the server's log. */
function upstreamText(error: unknown): string {
  if (error instanceof ExecError) return `exit ${error.exitCode}`;
  if (error instanceof Error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') return 'timed out';
    return clip(error.message);
  }
  return clip(String(error));
}

function clip(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > UPSTREAM_TEXT_LIMIT
    ? `${trimmed.slice(0, UPSTREAM_TEXT_LIMIT)}...`
    : trimmed;
}
