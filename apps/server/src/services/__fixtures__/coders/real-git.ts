import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_PATH, type GitAnswer } from './setup.js';

// A real repository behind the scripted `/coder`: git run in `REPO_PATH`
// (and the worktrees under it) runs the real git on a checkout in a
// temporary directory, its paths written back as `REPO_PATH` in what it
// says. A fetch, a clone and config writes stay scripted: there is no
// network, and the hardened config the runner sets is the test's to answer.

export interface RealRepo {
  /** The checkout on disk that `REPO_PATH` stands for. */
  readonly root: string;
  /** Runs real git in the checkout (or `cwd`), for the test's own setup; throws when it fails. */
  git(args: string[], cwd?: string): string;
  /** A `gitBy` answer: real git for commands run in the checkout, else undefined. */
  answer(args: string[], at: string | undefined): GitAnswer | undefined;
  remove(): void;
}

const SCRIPTED = new Set(['clone', 'fetch', 'config']);

/**
 * A checkout of a local bare origin. `empty` leaves both without commits;
 * otherwise `main` has one commit, pushed.
 */
export function realRepo({ empty = false }: { empty?: boolean } = {}): RealRepo {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'openbots-real-git-')));
  const root = join(base, 'relay');
  const env = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: base,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
    GIT_TERMINAL_PROMPT: '0',
  };
  const run = (args: string[], cwd: string) =>
    spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  const git = (args: string[], cwd = root) => {
    const out = run(args, cwd);
    if (out.status !== 0) throw new Error(`git ${args.join(' ')}: ${out.stderr}`);
    return out.stdout;
  };
  mkdirSync(root);
  git(['init', '--quiet', '--bare', '--initial-branch=main', join(base, 'origin.git')], base);
  git(['init', '--quiet', '--initial-branch=main'], root);
  git(['remote', 'add', 'origin', join(base, 'origin.git')]);
  if (!empty) {
    git(['commit', '--quiet', '--allow-empty', '-m', 'First']);
    git(['push', '--quiet', '-u', 'origin', 'main']);
  }
  const inside = (p: string) => p === REPO_PATH || p.startsWith(`${REPO_PATH}/`);
  return {
    root,
    git,
    answer(args, at) {
      if (!at || !inside(at) || args.some((a) => SCRIPTED.has(a))) return undefined;
      const mapped = args.map((a) => (inside(a) ? root + a.slice(REPO_PATH.length) : a));
      const out = run(mapped, base);
      const back = (s: string) => s.split(root).join(REPO_PATH);
      return { code: out.status ?? 1, stdout: back(out.stdout), stderr: back(out.stderr) };
    },
    remove() {
      rmSync(base, { recursive: true, force: true });
    },
  };
}
