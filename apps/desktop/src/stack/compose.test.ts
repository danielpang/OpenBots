import { describe, expect, it } from 'vitest';
import {
  bundledStackPaths,
  composeArgs,
  imageInspectArgs,
  isProjectName,
  LEGACY_PROJECT_NAME,
  parseComposePs,
  parseImages,
  PROJECT_NAME,
  type StackPaths,
} from './compose.js';

const paths: StackPaths = bundledStackPaths(
  '/Applications/OpenBot.app/Contents/Resources',
  '/Users/ada/Library/Application Support/OpenBot',
);

const BASE = [
  'compose',
  '--project-name',
  'openbot-app',
  '--project-directory',
  '/Users/ada/Library/Application Support/OpenBot/stack',
  '--env-file',
  '/Users/ada/Library/Application Support/OpenBot/stack/.env',
  '--file',
  '/Applications/OpenBot.app/Contents/Resources/stack/docker-compose.yml',
  '--file',
  '/Applications/OpenBot.app/Contents/Resources/stack/docker-compose.tunnels.yml',
];

describe('bundledStackPaths', () => {
  it('reads compose files from the bundle and keeps state in userData', () => {
    expect(paths).toEqual({
      composeFiles: [
        '/Applications/OpenBot.app/Contents/Resources/stack/docker-compose.yml',
        '/Applications/OpenBot.app/Contents/Resources/stack/docker-compose.tunnels.yml',
      ],
      projectDir: '/Users/ada/Library/Application Support/OpenBot/stack',
      envFile: '/Users/ada/Library/Application Support/OpenBot/stack/.env',
      envTemplate: '/Applications/OpenBot.app/Contents/Resources/stack/env.example',
    });
  });
});

describe('composeArgs', () => {
  it('starts detached, waits for health, never builds', () => {
    expect(composeArgs(paths, { kind: 'up' })).toEqual([
      ...BASE,
      'up',
      '--detach',
      '--wait',
      '--wait-timeout',
      '300',
      '--no-build',
      '--remove-orphans',
    ]);
  });

  it('stops without removing volumes', () => {
    const args = composeArgs(paths, { kind: 'down' });
    expect(args).toEqual([...BASE, 'down']);
    expect(args).not.toContain('--volumes');
    expect(args).not.toContain('-v');
  });

  it('lists services as JSON and pulls images', () => {
    expect(composeArgs(paths, { kind: 'ps' })).toEqual([
      ...BASE,
      'ps',
      '--all',
      '--format',
      'json',
    ]);
    expect(composeArgs(paths, { kind: 'pull' })).toEqual([...BASE, 'pull']);
  });

  it('follows logs with a tail and optional services', () => {
    expect(
      composeArgs(paths, { kind: 'logs', tail: 50, follow: true, services: ['openbot'] }),
    ).toEqual([...BASE, 'logs', '--no-color', '--tail', '50', '--follow', 'openbot']);
    expect(composeArgs(paths, { kind: 'logs', tail: -3, follow: false })).toEqual([
      ...BASE,
      'logs',
      '--no-color',
      '--tail',
      '200',
    ]);
  });

  it('passes paths with spaces as single arguments', () => {
    const args = composeArgs(paths, { kind: 'up' });
    expect(args[4]).toBe('/Users/ada/Library/Application Support/OpenBot/stack');
  });
});

describe('the project name', () => {
  it("is the app's own, apart from a source checkout's openbot, unless an older install keeps it", () => {
    expect(PROJECT_NAME).toBe('openbot-app');
    expect(LEGACY_PROJECT_NAME).toBe('openbot');
    expect(composeArgs(paths, { kind: 'ps' }, 'openbot').slice(0, 3)).toEqual([
      'compose',
      '--project-name',
      'openbot',
    ]);
    expect(isProjectName('openbot-app')).toBe(true);
    expect(isProjectName('Bad Name')).toBe(false);
    expect(isProjectName('')).toBe(false);
  });

  it('lists the images the stack runs, and inspects them in one call', () => {
    expect(composeArgs(paths, { kind: 'images' })).toEqual([...BASE, 'config', '--images']);
    expect(parseImages('a:1\nb:2\n\na:1\n')).toEqual(['a:1', 'b:2']);
    expect(imageInspectArgs(['a:1'])).toEqual(['image', 'inspect', '--format', '{{.Id}}', 'a:1']);
  });
});

describe('parseComposePs', () => {
  it('reads one JSON object per line (Compose 2.21+)', () => {
    const stdout = [
      JSON.stringify({ Service: 'openbot', State: 'running', Health: 'healthy' }),
      JSON.stringify({ Service: 'postgres', State: 'running', Health: '' }),
    ].join('\n');
    expect(parseComposePs(stdout)).toEqual([
      { service: 'openbot', state: 'running', health: 'healthy' },
      { service: 'postgres', state: 'running', health: '' },
    ]);
  });

  it('reads a JSON array (older Compose) and empty output', () => {
    expect(parseComposePs('[{"Service":"redis","State":"exited","Health":""}]')).toEqual([
      { service: 'redis', state: 'exited', health: '' },
    ]);
    expect(parseComposePs('\n')).toEqual([]);
  });
});
