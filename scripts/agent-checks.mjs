#!/usr/bin/env node
// The cheap checks, run when a coding agent finishes a turn (the Stop hook in
// .claude/settings.json) so a mistake the agent could have caught itself
// never spends CI or a reviewer's time. A person can run it too:
//
//   node scripts/agent-checks.mjs          # check what this branch changed
//   node scripts/agent-checks.mjs --plan   # print the commands, run nothing
//
// What it runs, only for what changed since the branch left main:
//   - prettier --check on the changed files
//   - typecheck, lint and test for the packages those files are in (Turborepo
//     caches each, so an unchanged package costs nothing)
//   - when a route changed: the OpenAPI document and client, regenerated
//
// As a hook it follows docs/VERIFICATION.md's rule for failing checks: it
// sends the failure back to the agent for up to three rounds in a session,
// then lets the turn end and tells the person what still fails. It never
// runs twice on the same tree, so a turn that changes nothing costs nothing.
//
// OPENBOTS_AGENT_CHECKS=off turns it off (set in .claude/settings.local.json).
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const MAX_ROUNDS = 3;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STATE_FILE = join(ROOT, '.verify', 'agent-checks.json');
// The workspace's own binaries, not `pnpm exec`: a hook can start with a PATH
// on which pnpm's shim is not runnable, and Turborepo spawns what it finds.
const bin = (name) => `node_modules/.bin/${name}`;
const PRETTIER_FILE = /\.(m?[jt]sx?|json|md|ya?ml|css|html)$/;

/** The workspace package a path is in: `{ dir, name }`, or null at the root. */
export function packageOf(path, read = readPackageName) {
  const parts = path.split('/');
  if (parts.length < 3 || !['apps', 'packages', 'ee'].includes(parts[0])) return null;
  const dir = `${parts[0]}/${parts[1]}`;
  const name = read(dir);
  return name ? { dir, name } : null;
}

function readPackageName(dir) {
  const file = join(ROOT, dir, 'package.json');
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8')).name ?? null;
}

/**
 * The commands for a set of changed paths, cheapest first. `exists` says
 * whether a path is still there (a deleted file cannot be formatted).
 */
export function planChecks(paths, { read = readPackageName, exists = () => true } = {}) {
  const steps = [];
  const format = paths.filter((path) => PRETTIER_FILE.test(path) && exists(path));
  if (format.length) {
    steps.push({
      name: 'format',
      command: [bin('prettier'), '--check', '--ignore-unknown', ...format],
      fix: `Fix with: pnpm exec prettier --write ${format.join(' ')}`,
    });
  }
  const code = paths.filter((path) => !path.endsWith('.md') && !path.startsWith('docs/'));
  const packages = [
    ...new Set(code.map((path) => packageOf(path, read)?.name).filter(Boolean)),
  ].sort();
  if (packages.length) {
    const filters = packages.map((name) => `--filter=${name}`);
    for (const task of ['typecheck', 'lint', 'test']) {
      steps.push({ name: task, command: [bin('turbo'), 'run', task, ...filters] });
    }
  }
  if (code.some((path) => /^apps\/server\/src\/(routes\/|openapi)/.test(path))) {
    steps.push({
      name: 'openapi',
      shell:
        'pnpm --filter @openbots/server openapi && ' +
        'pnpm exec prettier --write packages/api-client/openapi.json && ' +
        'pnpm --filter @openbots/api-client generate && ' +
        'git diff --exit-code --stat -- packages/api-client',
      fix: 'The command regenerated packages/api-client; include it in the change.',
    });
  }
  return steps;
}

/**
 * What the hook does after a run of the checks. `state` is this session's:
 * `{ rounds, tree }`. A pass clears the rounds; a failure counts one, and at
 * MAX_ROUNDS the turn is allowed to end with a note for the person.
 */
export function decide(state, { failed, tree }) {
  if (!failed) return { action: 'pass', state: { rounds: 0, tree } };
  const rounds = (state.rounds ?? 0) + 1;
  if (rounds > MAX_ROUNDS) return { action: 'handoff', state: { rounds, tree } };
  return { action: 'block', rounds, state: { rounds, tree: null } };
}

const git = (...args) =>
  execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

function changedPaths() {
  let base = 'HEAD';
  for (const ref of ['origin/main', 'main']) {
    try {
      base = git('merge-base', ref, 'HEAD').trim();
      break;
    } catch {
      // No such ref in this clone; compare with HEAD.
    }
  }
  const tracked = git('diff', '--name-only', '--no-renames', '-z', base).split('\0');
  const untracked = git('ls-files', '--others', '--exclude-standard', '-z').split('\0');
  return [...new Set([...tracked, ...untracked].filter(Boolean))].sort();
}

/** A digest of the tree's state: the same value means nothing changed since. */
function treeDigest(paths) {
  const hash = createHash('sha256').update(git('rev-parse', 'HEAD'));
  hash.update(git('diff', 'HEAD'));
  for (const path of paths) {
    const file = join(ROOT, path);
    hash.update(path);
    if (existsSync(file)) hash.update(git('hash-object', '--', path));
  }
  return hash.digest('hex');
}

function runStep(step) {
  const result = step.shell
    ? spawnSync('bash', ['-c', step.shell], { cwd: ROOT, encoding: 'utf8' })
    : spawnSync(step.command[0], step.command.slice(1), { cwd: ROOT, encoding: 'utf8' });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trimEnd();
  return { ok: result.status === 0, output };
}

const shown = (step) => step.shell ?? step.command.join(' ');
const tail = (text, lines = 60) => text.split('\n').slice(-lines).join('\n');

function readState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function main() {
  if (process.env.OPENBOTS_AGENT_CHECKS === 'off') return 0;
  const planOnly = process.argv.includes('--plan');
  // As a hook, the event arrives as JSON on stdin; from a terminal there is none.
  let event = null;
  if (!process.stdin.isTTY && !planOnly) {
    try {
      event = JSON.parse(readFileSync(0, 'utf8') || 'null');
    } catch {
      event = null;
    }
  }
  const session = event?.session_id ?? null;

  const paths = changedPaths();
  const steps = planChecks(paths, { exists: (path) => existsSync(join(ROOT, path)) });
  if (planOnly) {
    for (const step of steps) console.log(shown(step));
    return 0;
  }
  if (!steps.length) return 0;

  const all = readState();
  const state = (session && all[session]) || {};
  const tree = treeDigest(paths);
  if (state.tree === tree) return 0; // Already passed, or handed off, on exactly this tree.

  let failure = null;
  for (const step of steps) {
    if (!session) console.error(`==> ${shown(step)}`);
    const result = runStep(step);
    if (!result.ok) {
      failure = { step, output: result.output };
      break;
    }
  }

  const outcome = decide(state, { failed: Boolean(failure), tree });
  if (session) {
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify({ ...all, [session]: outcome.state }, null, 2));
  }
  if (outcome.action === 'pass') {
    if (!session) console.error('All checks passed.');
    return 0;
  }

  const report =
    `The ${failure.step.name} check failed:\n\n  ${shown(failure.step)}\n\n${tail(failure.output)}\n` +
    (failure.step.fix ? `\n${failure.step.fix}\n` : '');
  if (!session) {
    console.error(report);
    return 1;
  }
  if (outcome.action === 'handoff') {
    // Three rounds did not fix it: let the turn end and tell the person.
    process.stdout.write(
      JSON.stringify({
        systemMessage: `The ${failure.step.name} check still fails after ${MAX_ROUNDS} rounds of fixes, so the agent stopped. Run: ${shown(failure.step)}`,
      }),
    );
    return 0;
  }
  const last = outcome.rounds === MAX_ROUNDS;
  console.error(
    `${report}\nRound ${outcome.rounds} of ${MAX_ROUNDS}. ` +
      (last
        ? 'This was the last round. Do not try another fix: end the turn by telling the person what fails, what you tried and what you think the cause is.'
        : 'Fix the cause, not the check: do not skip or delete a test, add a sleep or a retry, or loosen a rule to get past this.'),
  );
  return 2; // Exit 2 from a Stop hook sends stderr back to the agent.
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
