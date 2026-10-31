import type { Auth } from './auth.js';
import type { NetOptions } from './builtins/net.js';
import type { Config } from './config.js';
import type { Db } from './db/client.js';
import type { Infra } from './infra/index.js';
import type { Logger } from './logger.js';
import type { GithubFetch } from './services/skill-import.js';
import type { Role } from './workspace.js';

/** What the server is built from; `main.ts` makes one, tests make their own. */
export interface AppDeps {
  config: Config;
  db: Db;
  auth: Auth;
  logger: Logger;
  /** Job queues and the event bus. */
  infra: Infra;
  /**
   * Exemptions from the outbound request guard for connectors, OAuth and
   * providers (S-8); tests that serve fakes on 127.0.0.1 set it.
   */
  net?: NetOptions;
  /** The GET behind Skill imports from GitHub; tests stand in recorded answers. */
  githubFetch?: GithubFetch;
}

/** The caller, set by `requireUser`. */
export interface CurrentUser {
  id: string;
  email: string;
  name: string;
  image: string | null;
  emailVerified: boolean;
  createdAt: Date;
  role: Role;
  workspaceId: string;
  /** How the request authenticated. */
  via: 'session' | 'api_key';
}

export interface AppEnv {
  Variables: {
    deps: AppDeps;
    requestId: string;
    /** Only on routes behind `requireUser` or `requireAdmin`. */
    user: CurrentUser;
  };
}
