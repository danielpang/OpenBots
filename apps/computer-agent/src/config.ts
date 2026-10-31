import path from 'node:path';

// The agent reads its settings from the environment the provider gives the
// container (plan 9.2), and its token from a file (S-7): the docker provider
// writes it into the state volume before each start, and the agent reads and
// deletes it before it listens, so it is in no process's environment. A
// remote agent may still take OPENBOT_AGENT_TOKEN.

export interface AgentConfig {
  /** Shared secret from OPENBOT_AGENT_TOKEN; when unset the agent reads `tokenFile`. */
  token?: string;
  tokenFile: string;
  port: number;
  host: string;
  /** Persistent home on the account's volume (K1, K7). */
  home: string;
  /** Default screen size for `POST /screens`. */
  width: number;
  height: number;
  /** Chromium binary; Playwright's bundled build when unset. */
  chromiumPath?: string;
  /** Scratch space: each screen's Xauthority, x11vnc password and wallpaper. */
  runtimeDir: string;
  /** Persistent and private to the agent: the token file and each screen's Chromium profile. */
  stateDir: string;
}

export const AGENT_ENV_VARS = [
  'OPENBOT_AGENT_TOKEN',
  'OPENBOT_AGENT_TOKEN_FILE',
  'OPENBOT_AGENT_PORT',
  'OPENBOT_AGENT_HOST',
  'OPENBOT_HOME',
  'OPENBOT_SCREEN_SIZE',
  'OPENBOT_CHROMIUM',
  'OPENBOT_RUNTIME_DIR',
  'OPENBOT_STATE_DIR',
] as const;

/**
 * The agent's own secrets, which no program it starts may see (S-7): a Bot's
 * command holding the token could call the agent API and drive any screen.
 */
export const SECRET_ENV_VARS = ['OPENBOT_AGENT_TOKEN'] as const;

/**
 * The environment for a child process: the agent's own, then `overlays` in
 * order, with every agent secret removed last so no overlay can put one back.
 */
export function childEnv(...overlays: (NodeJS.ProcessEnv | undefined)[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = Object.assign({}, process.env, ...overlays);
  for (const name of SECRET_ENV_VARS) delete env[name];
  return env;
}

export const MIN_TOKEN_LENGTH = 16;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const e = (name: (typeof AGENT_ENV_VARS)[number]) => {
    const value = env[name];
    return value === undefined || value === '' ? undefined : value;
  };
  const problems: string[] = [];

  const token = e('OPENBOT_AGENT_TOKEN');
  if (token !== undefined && token.length < MIN_TOKEN_LENGTH) {
    problems.push(`OPENBOT_AGENT_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters`);
  }

  const port = Number(e('OPENBOT_AGENT_PORT') ?? 7070);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    problems.push('OPENBOT_AGENT_PORT must be a port number');
  }

  const size = /^(\d+)x(\d+)$/.exec(e('OPENBOT_SCREEN_SIZE') ?? '1280x800');
  if (!size) problems.push('OPENBOT_SCREEN_SIZE must look like 1280x800');

  const home = e('OPENBOT_HOME') ?? '/home/bot';
  const stateDir = e('OPENBOT_STATE_DIR') ?? '/var/lib/openbot';
  const tokenFile = e('OPENBOT_AGENT_TOKEN_FILE') ?? path.join(stateDir, 'token');
  for (const [name, value] of [
    ['OPENBOT_HOME', home],
    ['OPENBOT_STATE_DIR', stateDir],
    ['OPENBOT_AGENT_TOKEN_FILE', tokenFile],
  ]) {
    if (!path.isAbsolute(value!)) problems.push(`${name} must be an absolute path`);
  }

  if (problems.length > 0) {
    throw new Error(`Invalid computer agent configuration:\n- ${problems.join('\n- ')}`);
  }
  return {
    ...(token !== undefined ? { token } : {}),
    tokenFile,
    port,
    host: e('OPENBOT_AGENT_HOST') ?? '0.0.0.0',
    home,
    width: Number(size![1]),
    height: Number(size![2]),
    chromiumPath: e('OPENBOT_CHROMIUM'),
    runtimeDir: e('OPENBOT_RUNTIME_DIR') ?? '/tmp/openbot',
    stateDir,
  };
}
