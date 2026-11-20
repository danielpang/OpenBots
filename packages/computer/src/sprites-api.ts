import {
  APIError,
  SpritesClient,
  type CheckpointStream,
  type RestoreStream,
  type SessionKillStream,
  type Sprite,
  type SpriteCommand,
} from '@fly/sprites';
import type { ComputerCheckpoint, EgressPolicy, EgressRule } from './types.js';

// The part of the Sprites API the sprites provider uses, behind a narrow
// interface so tests stand in a fake (`fakeSpritesApi` in testing.ts). The
// adapter below is the official SDK, @fly/sprites, with what the provider
// needs on top of it: a time limit on every call that ends the call (its
// request, stream or command) rather than only giving up on it, a missing
// Sprite or file read as null, and every failure turned into a
// `SpritesApiError`. Its text is our own (the operation and the Sprite) plus at
// most 500 characters of the API's answer, with the org token removed in every
// form and no URL (an exec's URL carries its command line and env). That text
// is for the server's log: on the hosted service the owner reads
// `HOSTED_FAILURE` instead (apps/server/src/services/computer.ts).
//
// Three endpoints are called directly, with the same requests the SDK sends:
// - Setting the network policy: SDK 0.2.4 accepts only 204 there, while the
//   API documents 200 with the stored policy and some Sprite runtimes answer
//   that; 0.2.5 fixes it. Move it to `sprite.updateNetworkPolicy` then.
// - Reading and writing a file: the SDK's calls take no AbortSignal, so one
//   that timed out would go on uploading and could land after a later attempt.
//
// What SDK 0.2.4 does not give, and how this adapter copes:
// - A refused exec upgrade (401, 404) reaches us without its HTTP status: the
//   SDK uses Node's WebSocket, whose error event carries none. Such a failure
//   has status 0.
// - The exec's session id and a bare exit frame (no code byte, which the SDK
//   reads as exit 0) are read from the SDK's own socket (`socketOf`). Without
//   that socket (a later SDK) a timed out command is still signalled and its
//   connection closed, and `max_run_after_disconnect` still ends it.

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
  /**
   * How long the command may go on once our connection to it is gone, as the
   * API's duration (`10s`, `1s`); the API's default is no limit. Default
   * `DEFAULT_MAX_RUN_AFTER_DISCONNECT`.
   */
  maxRunAfterDisconnect?: string;
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
  /**
   * Resolves with the new checkpoint's id once it is saved, or null when the
   * API did not name it and no listed checkpoint carries `comment` alone.
   */
  createCheckpoint(name: string, comment?: string): Promise<string | null>;
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
/**
 * The most an exec may print, stdout and stderr together, before it is
 * killed. The largest output the provider reads is a provisioning run's log
 * (apt, npm and Playwright's installs), a few hundred KiB; the rest are a few
 * lines.
 */
export const SPRITES_MAX_EXEC_OUTPUT_BYTES = 8 * 1024 * 1024;
/**
 * How long a command may outlive a dropped connection unless the caller says
 * otherwise: the provider's short commands finish in well under a second,
 * so one cut off near its end may finish, and none runs on unobserved.
 */
export const DEFAULT_MAX_RUN_AFTER_DISCONNECT = '10s';

export interface SpritesApiOptions {
  /** A Sprites org token (`sprite auth setup --token`, or the dashboard). */
  token: string;
  baseUrl?: string;
  /** Time limit for each call but `create`, `exec`, file writes and checkpoints. */
  timeoutMs?: number;
  /** Time limit for a file write. */
  writeTimeoutMs?: number;
  /** Time limit for a checkpoint or a restore. */
  checkpointTimeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const CREATE_TIMEOUT_MS = 2 * 60_000;
const DEFAULT_EXEC_TIMEOUT_MS = 10 * 60_000;
const WRITE_TIMEOUT_MS = 5 * 60_000;
/** Checkpoints take 10 to 30 seconds by the docs; restores are similar. */
const CHECKPOINT_TIMEOUT_MS = 10 * 60_000;
/** Ending a session: the API signals, waits up to 10 s, then kills. */
const KILL_TIMEOUT_MS = 20_000;
/** How much of the API's own answer an error keeps. */
const UPSTREAM_TEXT_LIMIT = 500;

export function createSpritesApi({
  token,
  baseUrl = SPRITES_API_URL,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  writeTimeoutMs = WRITE_TIMEOUT_MS,
  checkpointTimeoutMs = CHECKPOINT_TIMEOUT_MS,
}: SpritesApiOptions): SpritesApi {
  const base = baseUrl.replace(/\/+$/, '');
  // The SDK's own limit covers get, delete and the URL settings; its create
  // has a fixed two minutes. Everything else is limited here.
  const client = new SpritesClient(token, { baseURL: base, timeout: timeoutMs });
  const sprite = (name: string) => client.sprite(name);
  const redact = redactor(token);
  /**
   * Every error leaves the adapter through here: our words, then the API's,
   * without the token or a URL, then clipped (after the redaction, so a clip
   * cannot leave part of a token).
   */
  const fail = (what: string, name: string, error: unknown) => {
    const status = statusOf(error);
    const detail = clip(redact(withoutUrls(detailOf(error))));
    return new SpritesApiError(
      status,
      `Sprites API: ${what} failed${status ? ` (${status})` : ''} for ${name}${detail ? `: ${detail}` : ''}`,
    );
  };
  /** Runs one SDK call within `ms`, and maps what it throws. */
  async function call<T>(what: string, name: string, ms: number, run: () => Promise<T>) {
    try {
      return await within(ms, what, run());
    } catch (error) {
      throw fail(what, name, error);
    }
  }
  /** A file call, raw: see the header. */
  async function files(
    name: string,
    op: 'read' | 'write',
    path: string,
    init: { method: string; ms: number; body?: Uint8Array; params?: Record<string, string> },
  ): Promise<Response> {
    const url = new URL(`${base}/v1/sprites/${encodeURIComponent(name)}/fs/${op}`);
    url.searchParams.set('path', path);
    url.searchParams.set('workingDir', '/');
    for (const [key, value] of Object.entries(init.params ?? {})) url.searchParams.set(key, value);
    return fetch(url, {
      method: init.method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(init.body ? { 'content-type': 'application/octet-stream' } : {}),
      },
      ...(init.body ? { body: init.body } : {}),
      // Ends the request, the upload and the answer's body alike.
      signal: AbortSignal.timeout(init.ms),
    });
  }
  /** Ends an exec session, waiting until the API says it is gone (or the limit). */
  async function endSession(name: string, id: string) {
    await streamed(
      KILL_TIMEOUT_MS,
      'kill',
      () => sprite(name).killSession(id),
      async (stream: SessionKillStream) => {
        for await (const event of stream) if (event.type === 'complete') break;
      },
    );
  }

  return {
    async create(name, { urlAuth }) {
      const made = await call('create', name, CREATE_TIMEOUT_MS, () =>
        client.createSprite(name, { urlSettings: { auth: urlAuth } }),
      );
      return info(made);
    },
    async get(name) {
      try {
        return info(await within(timeoutMs, 'get', client.getSprite(name)));
      } catch (error) {
        if (statusOf(error) === 404) return null;
        throw fail('get', name, error);
      }
    },
    async delete(name) {
      try {
        await within(timeoutMs, 'delete', client.deleteSprite(name));
      } catch (error) {
        if (statusOf(error) === 404) return;
        throw fail('delete', name, error);
      }
    },
    async setUrlAuth(name, auth) {
      await call('URL settings', name, timeoutMs, () => client.updateURLSettings(name, { auth }));
    },
    // Raw: see the header. The same endpoint and body the SDK sends.
    async setNetworkPolicy(name, policy) {
      await call('network policy', name, timeoutMs, async () => {
        const response = await fetch(
          `${base}/v1/sprites/${encodeURIComponent(name)}/policy/network`,
          {
            method: 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: JSON.stringify({ rules: policy.rules }),
            signal: AbortSignal.timeout(timeoutMs),
          },
        );
        if (!response.ok) await refused(response);
        await response.body?.cancel();
      });
    },
    async exec(name, argv, options = {}) {
      if (argv.length === 0) throw new Error('exec needs a command');
      const linger = options.maxRunAfterDisconnect ?? DEFAULT_MAX_RUN_AFTER_DISCONNECT;
      if (!/^[1-9]\d{0,5}(ms|s|m)$/.test(linger)) {
        throw new Error(`Not a duration for maxRunAfterDisconnect: ${linger}`);
      }
      try {
        return await run(sprite(name), argv, { ...options, maxRunAfterDisconnect: linger }, (id) =>
          endSession(name, id),
        );
      } catch (error) {
        throw fail('exec', name, error);
      }
    },
    async writeFile(name, path, data, options = {}) {
      if (data.byteLength > SPRITES_MAX_WRITE_BYTES) {
        throw new Error(`fs/write takes at most ${SPRITES_MAX_WRITE_BYTES} bytes`);
      }
      try {
        const response = await files(name, 'write', path, {
          method: 'PUT',
          ms: writeTimeoutMs,
          body: data,
          params: {
            mkdirParents: 'true',
            ...(options.mode === undefined
              ? {}
              : { mode: options.mode.toString(8).padStart(4, '0') }),
          },
        });
        if (!response.ok) await refused(response);
        await response.body?.cancel();
      } catch (error) {
        throw fail('file write', name, error);
      }
    },
    async readFile(name, path) {
      try {
        const response = await files(name, 'read', path, { method: 'GET', ms: timeoutMs });
        // 404 is a missing file (the API leaves `code` out there) or Sprite.
        if (response.status === 404) {
          await response.body?.cancel();
          return null;
        }
        if (!response.ok) await refused(response);
        return new Uint8Array(await response.arrayBuffer());
      } catch (error) {
        throw fail('file read', name, error);
      }
    },
    async createCheckpoint(name, comment) {
      let done: string | undefined;
      try {
        done = await streamed(
          checkpointTimeoutMs,
          'checkpoint',
          () => sprite(name).createCheckpoint(comment),
          (stream) => finish(stream, 'checkpoint'),
        );
      } catch (error) {
        throw fail('checkpoint', name, error);
      }
      // "Checkpoint v8 created": the id is in the completion message. If a
      // later API words it otherwise, the checkpoint that carries the
      // caller's comment, and only that one: the newest may be an automatic
      // one or someone else's, and a restore to it would be the wrong disk.
      const id = /\b(v\d+)\b/.exec(done ?? '')?.[1];
      if (id) return id;
      if (!comment) return null;
      const ours = (await this.listCheckpoints(name)).filter((cp) => cp.comment === comment);
      return ours.length === 1 ? ours[0]!.id : null;
    },
    async listCheckpoints(name) {
      const listed = await call('checkpoint list', name, timeoutMs, () =>
        sprite(name).listCheckpoints(),
      );
      return listed.map((cp) => ({
        id: cp.id,
        createdAt: Number.isNaN(cp.createTime.getTime()) ? '' : cp.createTime.toISOString(),
        ...(cp.comment ? { comment: cp.comment } : {}),
      }));
    },
    async restoreCheckpoint(name, id) {
      try {
        await streamed(
          checkpointTimeoutMs,
          'restore',
          () => sprite(name).restoreCheckpoint(id),
          (stream) => finish(stream, 'restore'),
        );
      } catch (error) {
        throw fail('restore', name, error);
      }
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

/** Throws a refused raw call's status with the API's answer (redacted and clipped by `fail`). */
async function refused(response: Response): Promise<never> {
  const text = await response.text().catch(() => '');
  throw new SpritesApiError(response.status, text.trim());
}

/**
 * Opens a stream (a checkpoint, a restore, a session kill) and reads it with
 * `use`, all within `ms`. On the limit the stream is closed, which ends its
 * request; one that only arrives after the limit is closed as it arrives.
 */
async function streamed<S extends { close(): void }, T>(
  ms: number,
  what: string,
  open: () => Promise<S>,
  use: (stream: S) => Promise<T>,
): Promise<T> {
  let expired = false;
  let stream: S | undefined;
  const work = open().then((opened) => {
    stream = opened;
    if (expired) {
      opened.close();
      throw new SpritesApiError(0, `${what} timed out after ${ms} ms`);
    }
    return use(opened);
  });
  try {
    return await within(ms, what, work);
  } catch (error) {
    expired = true;
    stream?.close();
    throw error;
  }
}

/**
 * Reads a checkpoint or restore progress stream to its end. Throws on an
 * `error` event, or (the SDK does) when the stream ends without a final
 * event; resolves with the completion message. The stream is closed however
 * it ends.
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
        throw new SpritesApiError(0, `The ${what} failed: ${event.error ?? 'error'}`);
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

/** What the SDK's exec socket passes to us: Node's WebSocket, as far as used here. */
interface ExecSocket {
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
}

/**
 * The SDK's WebSocket under a command (`SpriteCommand.wsCmd.ws` in 0.2.4,
 * made as `spawn` returns), for what the SDK does not pass on: the session
 * id and the exit frame as sent. Undefined if a later SDK moves it.
 */
function socketOf(command: SpriteCommand): ExecSocket | undefined {
  const ws = (command as unknown as { wsCmd?: { ws?: Partial<ExecSocket> | null } }).wsCmd?.ws;
  return typeof ws?.addEventListener === 'function' ? (ws as ExecSocket) : undefined;
}

/**
 * Runs `argv` through the SDK's WebSocket exec, whose messages keep stdout,
 * stderr and the exit code apart (the HTTP exec's chunks carry no length).
 * stdin is written once the command has started, then closed, so a command
 * that reads it never waits; without `stdin` it gets an empty one, as the
 * HTTP exec gave. A connection that closes without an exit code is an error,
 * and so is an exit frame without its code byte.
 *
 * On a failure (the time limit, more output than SPRITES_MAX_EXEC_OUTPUT_BYTES,
 * a dropped connection) the command is signalled, the connection closed and
 * the session ended through the API (`endSession`, once its id is known)
 * before this rejects, so a retry does not overlap it. `max_run_after_disconnect`
 * ends it in any case.
 */
function run(
  sprite: Sprite,
  argv: string[],
  options: SpriteExecOptions & { maxRunAfterDisconnect: string },
  endSession: (id: string) => Promise<void>,
): Promise<SpriteExecResult> {
  const [file, ...args] = argv as [string, ...string[]];
  const timeoutMs = options.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const command = sprite.spawn(file, args, {
      ...(options.env ? { env: options.env } : {}),
      ...(options.cwd ? { cwd: options.cwd } : {}),
      maxRunAfterDisconnect: options.maxRunAfterDisconnect,
    });
    let sessionId: string | undefined;
    let bareExit = false;
    socketOf(command)?.addEventListener('message', ({ data }) => {
      if (typeof data === 'string') {
        try {
          const message = JSON.parse(data) as { type?: unknown; session_id?: unknown };
          const id = message.session_id;
          if (
            message.type === 'session_info' &&
            (typeof id === 'string' || typeof id === 'number')
          ) {
            sessionId = String(id);
          }
        } catch {
          // Not JSON: nothing for us.
        }
        return;
      }
      if (data instanceof ArrayBuffer && data.byteLength === 1) {
        bareExit = new Uint8Array(data)[0] === 3;
      }
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    let exitCode: number | undefined;
    let outEnded = false;
    let errEnded = false;
    let settled = false;
    const abort = async (error: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        command.kill();
      } catch {
        // The connection is gone; ending the session below still works.
      }
      command.close();
      if (sessionId) await endSession(sessionId).catch(() => undefined);
      reject(error);
    };
    const timer = setTimeout(() => {
      void abort(new SpritesApiError(0, `exec timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    const take = (parts: Buffer[]) => (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > SPRITES_MAX_EXEC_OUTPUT_BYTES) {
        void abort(
          new SpritesApiError(0, `exec output passed ${SPRITES_MAX_EXEC_OUTPUT_BYTES} bytes`),
        );
        return;
      }
      parts.push(chunk);
    };
    // Done once the exit code is in and both streams have ended (the SDK
    // ends them right after `exit`, so all their data is in by then).
    const done = () => {
      if (settled || exitCode === undefined || !outEnded || !errEnded) return;
      if (exitCode < 0 || bareExit) {
        void abort(new SpritesApiError(0, 'The exec ended without an exit code'));
        return;
      }
      settled = true;
      clearTimeout(timer);
      const text = (parts: Buffer[]) => Buffer.concat(parts).toString('utf8');
      resolve({ exitCode, stdout: text(out), stderr: text(err) });
    };
    command.stdout.on('data', take(out));
    command.stderr.on('data', take(err));
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
    command.on('error', (error: unknown) => void abort(error));
    command.on('spawn', () => {
      try {
        if (options.stdin !== undefined) command.stdin.write(options.stdin);
        command.stdin.end();
      } catch (error) {
        void abort(error);
      }
    });
  });
}

/** Resolves or rejects as `promise` does, or rejects once `ms` have passed. */
function within<T>(ms: number, what: string, promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new SpritesApiError(0, `${what} timed out after ${ms} ms`)),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** The API's HTTP status in what the SDK threw, when it says. */
function statusOf(error: unknown): number {
  if (error instanceof SpritesApiError) return error.status;
  if (error instanceof APIError) return error.statusCode ?? 0;
  // Several SDK calls throw a plain Error worded `... (status 404): <body>`.
  const match = /\(status (\d{3})\)/.exec(error instanceof Error ? error.message : '');
  return match ? Number(match[1]) : 0;
}

/** What a failure says, unredacted and unclipped: `fail` does both. */
function detailOf(error: unknown): string {
  if (error instanceof SpritesApiError) return error.message;
  if (error instanceof Error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') return 'timed out';
    return error.message;
  }
  return String(error);
}

/**
 * Removes the org token from text in each form an answer may echo it: as
 * sent, URL-encoded (either case of hex), and base64.
 */
function redactor(token: string): (text: string) => string {
  if (!token) return (text) => text;
  const encoded = Buffer.from(token).toString('base64');
  const forms = [
    token,
    encodeURIComponent(token),
    new URLSearchParams({ t: token }).toString().slice(2),
    encoded,
    encoded.replace(/=+$/, ''),
    Buffer.from(token).toString('base64url'),
  ];
  const pattern = new RegExp(
    [...new Set(forms)]
      .sort((a, b) => b.length - a.length)
      .map((form) => form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('|'),
    'gi',
  );
  return (text) => text.replace(pattern, '[token]');
}

/** The SDK's exec errors end in `(url: ws://...)`, the whole command line in its query. */
function withoutUrls(text: string): string {
  return text.replace(/\s*\(url: [^)]*\)/g, '').replace(/\b(?:wss?|https?):\/\/\S+/gi, '[url]');
}

function clip(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > UPSTREAM_TEXT_LIMIT
    ? `${trimmed.slice(0, UPSTREAM_TEXT_LIMIT)}...`
    : trimmed;
}
