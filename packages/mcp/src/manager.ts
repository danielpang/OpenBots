import { DEFAULT_PROCESS_LIMITS } from '@openbot/shared';
import type { McpHost, McpHostOptions, ToolCallResult } from './host.js';
import type { McpSnapshot, McpTool } from './types.js';

// The MCP client manager (plan 8): one session per connector, started on first
// use, stopped after `idleMs` without use, pinged by a health loop, and
// restarted when the connector's config or secrets change (a new `version`).
// It knows nothing about the database; the server supplies `resolve` (build a
// host for a connector id) and the callbacks that persist what it learns.

export interface ConnectorSession {
  id: string;
  /** Changes whenever config or secrets change; a session on an older version is replaced. */
  version: string;
  create(options: McpHostOptions): McpHost;
}

export interface McpManagerOptions {
  /** Builds the session for a connector; throws when it may not start (blocked, missing login). */
  resolve(connectorId: string): Promise<ConnectorSession>;
  /** After every successful start. */
  onStarted?(connectorId: string, snapshot: McpSnapshot): Promise<void> | void;
  /** After `tools/list_changed`, with the new list. */
  onToolsChanged?(connectorId: string, tools: McpTool[]): Promise<void> | void;
  /** When a start, ping or session fails. */
  onError?(connectorId: string, error: Error): Promise<void> | void;
  /** A session unused this long is stopped; the server passes OPENBOT_MCP_IDLE_STOP_MINUTES. */
  idleMs?: number;
  healthIntervalMs?: number;
  requestTimeoutMs?: number;
  now?: () => number;
}

interface Session {
  version: string;
  host: McpHost;
  lastUsed: number;
  /** Calls in flight; an idle check never stops a session that is busy. */
  busy: number;
}

/** `idleMs` when none is given: the process limit's default, 10 minutes. */
export const DEFAULT_IDLE_MS: number = DEFAULT_PROCESS_LIMITS.mcpIdleStopMinutes * 60_000;
/**
 * How often the health loop pings each session and stops idle ones, so an
 * idle session stops up to this much after `idleMs`. Internal: it trades a
 * ping a minute per running server against noticing a dead one late.
 */
export const DEFAULT_HEALTH_MS = 60_000;

export class McpManager {
  private readonly sessions = new Map<string, Session>();
  private readonly starting = new Map<
    string,
    Promise<{ session: Session; snapshot: McpSnapshot }>
  >();
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly now: () => number;
  /** How long a session may go unused before the health loop stops it. */
  readonly idleMs: number;

  constructor(private readonly options: McpManagerOptions) {
    this.now = options.now ?? Date.now;
    this.idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
  }

  /** Starts the health loop (idle stop plus ping). */
  startHealthLoop(): void {
    if (this.timer) return;
    this.timer = setInterval(
      () => void this.checkHealth(),
      this.options.healthIntervalMs ?? DEFAULT_HEALTH_MS,
    );
    this.timer.unref?.();
  }

  /** Whether a session is running for the connector. */
  running(connectorId: string): boolean {
    return this.sessions.has(connectorId);
  }

  /** The running host, started if needed. */
  async host(connectorId: string): Promise<McpHost> {
    return (await this.session(connectorId)).host;
  }

  async callTool(
    connectorId: string,
    name: string,
    args: Record<string, unknown>,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<ToolCallResult> {
    const session = await this.session(connectorId);
    session.busy++;
    try {
      return await session.host.callTool(name, args, options);
    } finally {
      session.busy--;
      session.lastUsed = this.now();
    }
  }

  /** Restarts the connector's session and returns what it lists (the Test button). */
  async test(connectorId: string): Promise<McpSnapshot> {
    await this.stop(connectorId);
    const { snapshot } = await this.startSession(connectorId);
    return snapshot;
  }

  async stop(connectorId: string): Promise<void> {
    await this.starting.get(connectorId)?.catch(() => {});
    const session = this.sessions.get(connectorId);
    if (!session) return;
    this.sessions.delete(connectorId);
    await session.host.close().catch(() => {});
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await Promise.all([...this.sessions.keys()].map((id) => this.stop(id)));
  }

  /** One pass of the health loop; exported for tests. */
  async checkHealth(): Promise<void> {
    const now = this.now();
    const { idleMs } = this;
    await Promise.all(
      [...this.sessions.entries()].map(async ([id, session]) => {
        if (session.busy === 0 && now - session.lastUsed >= idleMs) {
          await this.stop(id);
          return;
        }
        try {
          await session.host.ping();
        } catch (err) {
          if (this.sessions.get(id) === session) await this.stop(id);
          await this.options.onError?.(id, err as Error);
        }
      }),
    );
  }

  private async session(connectorId: string): Promise<Session> {
    const pending = this.starting.get(connectorId);
    if (pending) return (await pending).session;
    const existing = this.sessions.get(connectorId);
    if (existing) {
      const spec = await this.options.resolve(connectorId);
      if (spec.version === existing.version && this.sessions.get(connectorId) === existing) {
        existing.lastUsed = this.now();
        return existing;
      }
      await this.stop(connectorId);
    }
    return (await this.startSession(connectorId)).session;
  }

  private startSession(connectorId: string) {
    const pending = this.starting.get(connectorId);
    if (pending) return pending;
    const promise = (async () => {
      const spec = await this.options.resolve(connectorId);
      const ref: { session?: Session } = {};
      const host = spec.create({
        requestTimeoutMs: this.options.requestTimeoutMs,
        onToolsChanged: (tools) => void this.options.onToolsChanged?.(connectorId, tools),
        onClose: () => {
          if (ref.session && this.sessions.get(connectorId) === ref.session) {
            this.sessions.delete(connectorId);
          }
        },
      });
      let snapshot: McpSnapshot;
      try {
        snapshot = await host.start();
      } catch (err) {
        await host.close().catch(() => {});
        await this.options.onError?.(connectorId, err as Error);
        throw err;
      }
      const session: Session = { version: spec.version, host, lastUsed: this.now(), busy: 0 };
      ref.session = session;
      this.sessions.set(connectorId, session);
      await this.options.onStarted?.(connectorId, snapshot);
      return { session, snapshot };
    })();
    this.starting.set(connectorId, promise);
    void promise.then(
      () => this.starting.delete(connectorId),
      () => this.starting.delete(connectorId),
    );
    return promise;
  }
}
