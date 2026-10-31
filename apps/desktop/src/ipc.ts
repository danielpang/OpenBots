// The IPC contract between the main process and the preload (plan 14.4).
// Channel names and the shapes that cross them; the stack manager's own
// channels are in ./stack/bridge.ts.

export const DESKTOP_CHANNELS = {
  /** main → renderer: open a path of the web app (a deep link or a tray click). */
  navigate: 'openbot:navigate',
  /** main → renderer: the File menu's New (Cmd+N) opens the web app's New dialog. */
  newItem: 'openbot:new',
  profilesList: 'openbot:profiles:list',
  profilesAdd: 'openbot:profiles:add',
  profilesRemove: 'openbot:profiles:remove',
  profilesOpen: 'openbot:profiles:open',
  /** The first-run choices: the three ways to connect (app pages only). */
  connectOptions: 'openbot:connect:options',
  connectCloud: 'openbot:connect:cloud',
  connectCheck: 'openbot:connect:check',
  connectServer: 'openbot:connect:server',
  connectLocal: 'openbot:connect:local',
  /** How the app is connected, for the web app's indicator (the active server's page too). */
  connectionInfo: 'openbot:connection:info',
  connectionChange: 'openbot:connection:change',
  connectionStart: 'openbot:connection:start',
  connectionStop: 'openbot:connection:stop',
  connectionLogs: 'openbot:connection:logs',
  /** A connector's OAuth sign-in: open its page in the default browser, then come back (web app). */
  oauthOpen: 'openbot:oauth:open',
  oauthFinished: 'openbot:oauth:finished',
  quickAskBots: 'openbot:quick-ask:bots',
  quickAskSend: 'openbot:quick-ask:send',
  quickAskClose: 'openbot:quick-ask:close',
} as const;

/**
 * What the web app reads as `window.openbot.platform` to turn on native
 * features. A browser has no `window.openbot`.
 */
export interface PlatformInfo {
  kind: 'desktop';
  /** `process.platform` of the Mac app's host: 'darwin', later 'win32' and 'linux'. */
  os: string;
  /** The app version. */
  version: string;
  /** The shell shows approvals, questions, mentions and Routine exceptions natively (N1). */
  nativeNotifications: boolean;
}

/**
 * How the app reaches its server: `local` runs the bundled stack on this Mac
 * in Docker; `cloud` is the hosted OpenBots server and `remote` a self-hosted
 * one. Both of those are thin clients that never touch Docker.
 */
export type ProfileKind = 'local' | 'remote' | 'cloud';

/** A server the app can open: the local stack, the hosted server, or any tunnel or remote URL. */
export interface ServerProfile {
  id: string;
  name: string;
  /** The server's origin, e.g. `http://localhost:3000` or `https://openbot.example.com`. */
  url: string;
  kind: ProfileKind;
}

export interface ProfilesView {
  activeId: string;
  profiles: ServerProfile[];
  /** The owner has picked a connection; until then the app shows the three choices. */
  chosen: boolean;
}

export interface QuickAskBot {
  id: string;
  name: string;
}

export interface QuickAskResult {
  botId: string;
  seq: number;
}

/** What the welcome screen needs to offer the three choices. */
export interface ConnectOptions {
  /** The hosted OpenBots server from the build; null disables "Sign in to an OpenBots account". */
  cloudUrl: string | null;
  /** A connection was chosen before: the welcome screen came from "Change connection…". */
  chosen: boolean;
}

/** A self-hosted server that answered as an OpenBots server. */
export interface ServerCheckResult {
  url: string;
  setupRequired: boolean;
  /** Shown for plain http on a private network. */
  warning: string | null;
}

/** The local stack as the indicator shows it: This Mac only. */
export interface LocalStackHealth {
  state: 'running' | 'unhealthy' | 'stopped';
  /** One line, as the start page says it. */
  text: string;
}

/** How the app is connected, for the web app's indicator and the tray. */
export interface ConnectionInfo {
  kind: ProfileKind;
  /** "This Mac", "Self-hosted" or "OpenBots account". */
  label: string;
  /** The server's host, e.g. `openbot.example.com` or `localhost:3000`. */
  host: string;
  url: string;
  /** This Mac only; a thin client (cloud, remote) never asks Docker. */
  stack?: LocalStackHealth;
}
