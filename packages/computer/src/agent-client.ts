import type {
  BrowserActionInput,
  BrowserActionName,
  BrowserResult,
  CookieSyncResult,
  ExecEvent,
  ExecRequest,
  FsEntry,
  FsListing,
  InputAction as AgentInputAction,
  ScreenInfo,
} from '@openbot/computer-agent/protocol';
import type { InputAction } from './actions.js';
import { COMPUTER_HOME } from './types.js';

// The HTTP client for the control agent inside the computer (plan 9.3), whose
// wire format is `@openbot/computer-agent/protocol`. Every request carries
// `Authorization: Bearer <agent token>`; errors are problem documents, thrown
// here as `AgentError` with their `detail` and `code`.
//
// Paths: the agent's `/fs` is relative to its home; this client takes
// absolute paths under /home/bot (as the tools and the file browser use them)
// and refuses others. Screens are addressed by number `n` (display `:10+n`).

export type { CookieSyncResult, ExecRequest, ScreenInfo };

export interface ExecResult {
  /** -1 when the command was killed by a signal. */
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type ExecChunk = { type: 'stdout' | 'stderr'; data: string };

export interface DirEntry {
  name: string;
  /** Absolute, under /home/bot. */
  path: string;
  type: FsEntry['type'];
  size: number;
  /** ISO timestamp. */
  mtime: string;
}

export interface DirListing {
  /** Absolute, under /home/bot. */
  path: string;
  entries: DirEntry[];
}

export type PageInfo = BrowserResult;
export type PageSnapshot = BrowserResult & { snapshot: string };

export type BrowserAction = {
  // `snapshot` takes no fields (its input is `Record<string, never>`).
  [A in BrowserActionName]: string extends keyof BrowserActionInput<A>
    ? { action: A }
    : { action: A } & BrowserActionInput<A>;
}[BrowserActionName];

export interface ComputerAgentClient {
  readonly url: string;
  health(signal?: AbortSignal): Promise<{ ok: boolean; version?: string }>;
  exec(
    request: ExecRequest,
    options?: { signal?: AbortSignal; onChunk?(chunk: ExecChunk): void },
  ): Promise<ExecResult>;
  readFile(path: string, signal?: AbortSignal): Promise<Uint8Array>;
  /** A streaming read for downloads. */
  openFile(path: string, signal?: AbortSignal): Promise<Response>;
  writeFile(
    path: string,
    body: Uint8Array | string,
    signal?: AbortSignal,
  ): Promise<{ size: number }>;
  deleteFile(path: string, options?: { recursive?: boolean; signal?: AbortSignal }): Promise<void>;
  list(path: string, signal?: AbortSignal): Promise<DirListing>;
  startScreen(
    /** `fresh`: start from an empty Chromium profile, restarting the screen if it runs. */
    screen: { n: number; width?: number; height?: number; fresh?: boolean },
    signal?: AbortSignal,
  ): Promise<ScreenInfo>;
  stopScreen(n: number, signal?: AbortSignal): Promise<void>;
  screenshot(n: number, signal?: AbortSignal): Promise<Uint8Array>;
  input(n: number, action: InputAction, signal?: AbortSignal): Promise<void>;
  browser<T extends BrowserResult = BrowserResult>(
    n: number,
    action: BrowserAction,
    signal?: AbortSignal,
  ): Promise<T>;
  setWallpaper(hour?: number, signal?: AbortSignal): Promise<void>;
  /**
   * Exports screen `screen`'s cookies, or every running screen's, into the
   * computer's shared store now and spreads them to the other screens (K1).
   */
  syncCookies(screen?: number, signal?: AbortSignal): Promise<CookieSyncResult>;
  /** The WebSocket URL and headers the server's proxies dial (`/pty`, `/vnc/:n`). */
  socket(path: `/pty${string}` | `/vnc/${number}`): {
    url: string;
    headers: Record<string, string>;
  };
}

export class AgentError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'AgentError';
  }
}

export interface AgentClientOptions {
  url: string;
  token: string;
  /** Per-request timeout for everything but `exec`, which has its own. */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 30_000;
/** Slack on top of an exec's own timeout before the client gives up on the agent. */
const EXEC_GRACE_MS = 10_000;
const DEFAULT_EXEC_TIMEOUT_MS = 120_000;

export function createAgentClient({
  url,
  token,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetch: doFetch = fetch,
}: AgentClientOptions): ComputerAgentClient {
  const base = url.replace(/\/+$/, '');
  const auth = { authorization: `Bearer ${token}` };

  async function request(
    method: string,
    path: string,
    init: {
      body?: RequestInit['body'];
      json?: unknown;
      signal?: AbortSignal | undefined;
      timeoutMs?: number;
    } = {},
  ): Promise<Response> {
    const signals = [AbortSignal.timeout(init.timeoutMs ?? timeoutMs)];
    if (init.signal) signals.push(init.signal);
    const headers: Record<string, string> = { ...auth };
    let body = init.body;
    if (init.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(init.json);
    } else if (body !== undefined) {
      headers['content-type'] = 'application/octet-stream';
    }
    const response = await doFetch(`${base}${path}`, {
      method,
      headers,
      body,
      signal: AbortSignal.any(signals),
    });
    if (!response.ok) throw await agentError(response);
    return response;
  }

  const json = async <T>(response: Response) => (await response.json()) as T;
  // `GET /fs/*` answers a directory with its JSON listing and a file with its bytes.
  const isListing = (response: Response) =>
    (response.headers.get('content-type') ?? '').includes('application/json');

  async function file(path: string, signal?: AbortSignal) {
    const response = await request('GET', fsPath(path), { signal });
    if (isListing(response)) {
      await response.body?.cancel();
      throw new AgentError(409, `${path} is a directory`, 'IS_A_DIRECTORY');
    }
    return response;
  }

  return {
    url: base,
    async health(signal) {
      const body = await json<{ status?: string; version?: string }>(
        await request('GET', '/healthz', { signal, timeoutMs: 5_000 }),
      );
      return { ok: body.status === 'ok', ...(body.version ? { version: body.version } : {}) };
    },
    async exec(req, { signal, onChunk } = {}) {
      const response = await request('POST', '/exec', {
        json: req,
        signal,
        timeoutMs: (req.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS) + EXEC_GRACE_MS,
      });
      return readExecStream(response, onChunk);
    },
    readFile: async (path, signal) =>
      new Uint8Array(await (await file(path, signal)).arrayBuffer()),
    openFile: (path, signal) => file(path, signal),
    async writeFile(path, body, signal) {
      const data = typeof body === 'string' ? new TextEncoder().encode(body) : body;
      const response = await request('PUT', fsPath(path), {
        body: data as RequestInit['body'],
        signal,
      });
      const written = await json<Partial<FsEntry>>(response);
      return { size: written.size ?? data.byteLength };
    },
    async deleteFile(path, { recursive, signal } = {}) {
      await request('DELETE', `${fsPath(path)}${recursive ? '?recursive=1' : ''}`, { signal });
    },
    async list(path, signal) {
      const response = await request('GET', fsPath(path), { signal });
      if (!isListing(response)) {
        await response.body?.cancel();
        throw new AgentError(409, `${path} is not a directory`, 'NOT_A_DIRECTORY');
      }
      const listing = await json<FsListing>(response);
      return {
        path: absolute(listing.path),
        entries: listing.entries.map((e) => ({
          name: e.name,
          path: absolute(e.path),
          type: e.type,
          size: e.size,
          mtime: e.modifiedAt,
        })),
      };
    },
    startScreen: async (screen, signal) =>
      json<ScreenInfo>(
        await request('POST', '/screens', { json: screen, signal, timeoutMs: 60_000 }),
      ),
    async stopScreen(n, signal) {
      await request('DELETE', `/screens/${n}`, { signal });
    },
    screenshot: async (n, signal) =>
      new Uint8Array(
        await (await request('GET', `/screens/${n}/screenshot`, { signal })).arrayBuffer(),
      ),
    async input(n, action, signal) {
      await request('POST', `/screens/${n}/input`, { json: toAgentInput(action), signal });
    },
    async browser<T extends BrowserResult>(
      n: number,
      { action, ...body }: BrowserAction,
      signal?: AbortSignal,
    ) {
      return json<T>(
        await request('POST', `/screens/${n}/browser/${action}`, {
          json: body,
          signal,
          timeoutMs: 130_000,
        }),
      );
    },
    async setWallpaper(hour, signal) {
      await request('POST', '/wallpaper', { json: hour === undefined ? {} : { hour }, signal });
    },
    syncCookies: async (screen, signal) =>
      json<CookieSyncResult>(
        await request('POST', '/cookies/sync', {
          json: screen === undefined ? {} : { screen },
          signal,
        }),
      ),
    socket: (path) => ({ url: `${base.replace(/^http/, 'ws')}${path}`, headers: { ...auth } }),
  };
}

/** The agent's xdotool input for one of the plan's pixel actions. */
export function toAgentInput(action: InputAction): AgentInputAction {
  switch (action.action) {
    case 'click': {
      const [x, y] = action.coordinate;
      return {
        action: 'click',
        x,
        y,
        ...(action.button ? { button: action.button } : {}),
        ...(action.count ? { count: action.count } : {}),
      };
    }
    case 'double_click':
      return { action: 'double_click', x: action.coordinate[0], y: action.coordinate[1] };
    case 'type':
      return { action: 'type', text: action.text };
    case 'key':
      return { action: 'key', keys: action.text };
    case 'scroll':
      return {
        action: 'scroll',
        x: action.coordinate[0],
        y: action.coordinate[1],
        direction: action.direction,
        ...(action.amount ? { amount: action.amount } : {}),
      };
    case 'move':
      return { action: 'move', x: action.coordinate[0], y: action.coordinate[1] };
    case 'drag':
      return {
        action: 'drag',
        from: { x: action.from[0], y: action.from[1] },
        to: { x: action.to[0], y: action.to[1] },
      };
  }
}

/** `/fs/` plus the path relative to the home, each segment escaped. */
function fsPath(path: string) {
  if (path !== COMPUTER_HOME && !path.startsWith(`${COMPUTER_HOME}/`)) {
    throw new AgentError(
      403,
      `Only files under ${COMPUTER_HOME} are reachable`,
      'PATH_OUTSIDE_HOME',
    );
  }
  const rel = path.slice(COMPUTER_HOME.length).replace(/^\/+/, '');
  return `/fs/${rel
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')}`;
}

function absolute(rel: string) {
  return rel ? `${COMPUTER_HOME}/${rel}` : COMPUTER_HOME;
}

async function agentError(response: Response) {
  let message = `${response.status} ${response.statusText}`.trim();
  let code: string | undefined;
  try {
    const body = (await response.json()) as { detail?: unknown; code?: unknown };
    if (typeof body.detail === 'string') message = body.detail;
    if (typeof body.code === 'string') code = body.code;
  } catch {
    // Not JSON; keep the status line.
  }
  return new AgentError(response.status, message, code);
}

async function readExecStream(
  response: Response,
  onChunk?: (chunk: ExecChunk) => void,
): Promise<ExecResult> {
  const result: ExecResult = { exitCode: -1, stdout: '', stderr: '', timedOut: false };
  const decoder = new TextDecoder();
  let buffered = '';
  let failure: string | null = null;
  const line = (text: string) => {
    if (!text.trim()) return;
    const event = JSON.parse(text) as ExecEvent;
    if (event.type === 'stdout' || event.type === 'stderr') {
      result[event.type] += event.data;
      onChunk?.(event);
    } else if (event.type === 'exit') {
      result.exitCode = event.exitCode ?? -1;
      result.timedOut = event.timedOut;
    } else if (event.type === 'error') {
      failure = event.message;
    }
  };
  if (response.body) {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      buffered += decoder.decode(chunk, { stream: true });
      let at: number;
      while ((at = buffered.indexOf('\n')) >= 0) {
        line(buffered.slice(0, at));
        buffered = buffered.slice(at + 1);
      }
    }
  }
  line(buffered + decoder.decode());
  if (failure !== null) throw new AgentError(500, failure, 'EXEC_FAILED');
  return result;
}
