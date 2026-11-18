#!/usr/bin/env node
// How commits say they were verified, counted. Every commit ends with a
// `Verified:` trailer (docs/VERIFICATION.md, "The stamp"); `none` is a valid
// value, so the commits nobody verified can be found.
//
//   node scripts/verification-stamps.mjs check <base> [head]
//     The commits of a pull request. Reads the pull request's description
//     from PR_BODY too: a squash merge keeps that, not the commits. With
//     VERIFICATION_STAMPS=enforce it exits 1 when neither carries a stamp;
//     in observe mode (the default) it only reports.
//
//   node scripts/verification-stamps.mjs report [--days 30]
//     The review of the checks themselves, as Markdown: stamps on the default
//     branch, reverts and quick follow-up fixes (changes a check missed), and
//     how large the rules have grown. The monthly workflow
//     .github/workflows/verification-review.yml opens an issue with it.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseStamp, STAMPS } from './agent-commit-gate.mjs';
import { CHECKLIST } from './reliability-checklist.mjs';

const git = (...args) =>
  execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

/** Commits in a range, oldest first: `{ sha, subject, body }`. Merges are left out. */
export function commitsIn(range) {
  const out = git('log', '--no-merges', '--reverse', '--format=%H%x1f%s%x1f%b%x1e', ...range);
  return out
    .split('\x1e')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [sha, subject, body = ''] = entry.split('\x1f');
      return { sha, subject, body };
    });
}

/** The stamp value of a commit: one of STAMPS, `invalid`, or `missing`. */
export function stampOf(commit) {
  const stamp = parseStamp(commit.body);
  if (!stamp) return 'missing';
  if (!STAMPS.includes(stamp.value)) return 'invalid';
  if (stamp.value === 'none' && !stamp.reason) return 'invalid';
  return stamp.value;
}

export function tally(commits) {
  const counts = Object.fromEntries([...STAMPS, 'invalid', 'missing'].map((key) => [key, 0]));
  for (const commit of commits) counts[stampOf(commit)]++;
  return counts;
}

/**
 * Changes a check missed, as far as history can show: reverts, and fixes
 * that touch a file another commit changed within `days` before them.
 */
export function misses(commits, filesOf, days = 14) {
  const reverts = commits.filter((c) => /^revert\b/i.test(c.subject));
  const followUps = [];
  const window = days * 24 * 60 * 60 * 1000;
  const fixes = commits.filter((c) => /^fix\b|^fix[(:]/i.test(c.subject));
  for (const fix of fixes) {
    const files = new Set(filesOf(fix.sha));
    // The latest earlier change to one of the same files. A commit that
    // touches hundreds of files (an import, a rename) explains nothing.
    const cause = commits.findLast(
      (c) =>
        c.sha !== fix.sha &&
        c.at < fix.at &&
        fix.at - c.at <= window &&
        filesOf(c.sha).length <= MAX_CAUSE_FILES &&
        filesOf(c.sha).some((file) => files.has(file) && !/lock\.yaml$|\.md$/.test(file)),
    );
    if (cause) followUps.push({ fix, cause });
  }
  return { reverts, followUps };
}

const MAX_CAUSE_FILES = 150;

const lines = (path) => (existsSync(path) ? readFileSync(path, 'utf8').split('\n').length : 0);

function countFiles(dir, pattern) {
  if (!existsSync(dir)) return 0;
  let count = 0;
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) count += countFiles(path, pattern);
    else if (pattern.test(entry)) count++;
  }
  return count;
}

function skillFiles() {
  return git('ls-files', '-z', '--', '*.claude/skills/*/SKILL.md', '.claude/skills/*/SKILL.md')
    .split('\0')
    .filter(Boolean);
}

function check(base, head = 'HEAD') {
  const commits = commitsIn([`${base}..${head}`]);
  const counts = tally(commits);
  const body = parseStamp(process.env.PR_BODY ?? '');
  const bodyValue = body && STAMPS.includes(body.value) ? body.value : null;
  console.log(`Verification stamps on ${commits.length} commit(s):`);
  for (const commit of commits) {
    console.log(`  ${commit.sha.slice(0, 7)}  ${stampOf(commit).padEnd(10)}  ${commit.subject}`);
  }
  console.log(`The pull request description: ${bodyValue ?? 'no stamp'}`);
  const unstamped = counts.missing + counts.invalid;
  if (!unstamped || bodyValue) return 0;
  const message = `${unstamped} commit(s) do not say how they were verified, and neither does the pull request description. Add a "Verified:" trailer (docs/VERIFICATION.md).`;
  if (process.env.VERIFICATION_STAMPS === 'enforce') {
    console.log(`::error::${message}`);
    return 1;
  }
  console.log(`::notice::${message} Observe mode: not failing.`);
  return 0;
}

function report(days) {
  const since = `--since=${days} days ago`;
  const raw = git('log', '--no-merges', '--reverse', since, '--format=%H%x1f%ct%x1f%s%x1f%b%x1e');
  const commits = raw
    .split('\x1e')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [sha, at, subject, body = ''] = entry.split('\x1f');
      return { sha, at: Number(at) * 1000, subject, body };
    });
  const files = new Map();
  const filesOf = (sha) => {
    if (!files.has(sha)) {
      files.set(sha, git('show', '--name-only', '--format=', sha).split('\n').filter(Boolean));
    }
    return files.get(sha);
  };
  const counts = tally(commits);
  const { reverts, followUps } = misses(commits, filesOf);
  const short = (c) => `\`${c.sha.slice(0, 7)}\` ${c.subject}`;
  const out = [];
  out.push(`## Verification review: the last ${days} days\n`);
  out.push(
    'This issue is opened on a schedule so the checks get reviewed like the code they judge. Work through it with the `tidy-checks` skill (`.claude/skills/tidy-checks`), or by hand, then close it.\n',
  );
  out.push(`### How ${commits.length} commits on the default branch were verified\n`);
  out.push('| Stamp | Commits |', '| --- | --- |');
  for (const [stamp, count] of Object.entries(counts)) out.push(`| ${stamp} | ${count} |`);
  out.push('');
  out.push(`### Changes a check missed\n`);
  out.push(
    `Reverts: ${reverts.length}. Fixes within 14 days of a change to the same file: ${followUps.length}.\n`,
  );
  for (const revert of reverts) out.push(`- Revert: ${short(revert)}`);
  for (const { fix, cause } of followUps) out.push(`- ${short(fix)}, after ${short(cause)}`);
  if (reverts.length + followUps.length) {
    out.push(
      '\nFor each: could a diff have shown it? If so, and it has happened in two pull requests, it is a candidate item for `scripts/reliability-checklist.mjs` or a line in `REVIEW.md`.',
    );
  }
  out.push('\n### How large the rules have grown\n');
  out.push('| What | Size |', '| --- | --- |');
  out.push(`| Reliability checklist items | ${CHECKLIST.length} |`);
  out.push(`| CLAUDE.md lines | ${lines('CLAUDE.md')} |`);
  out.push(`| REVIEW.md lines | ${lines('REVIEW.md')} |`);
  out.push(`| Skills | ${skillFiles().length} |`);
  out.push(`| Browser specs | ${countFiles('apps/web/e2e', /\.spec\.ts$/)} |`);
  let tests = 0;
  let properties = 0;
  for (const root of ['apps', 'packages', 'ee']) {
    tests += countFiles(root, /\.test\.tsx?$/);
    properties += countFiles(root, /\.property\.test\.ts$/);
  }
  out.push(`| Test files | ${tests} |`);
  out.push(`| Property test files | ${properties} |`);
  out.push(
    '\nRules only grow unless someone prunes them. Remove a checklist item or a rule when a test or a type now makes the mistake impossible, when it has not matched a diff in months, or when two say the same thing. Delete a test that cannot fail.',
  );
  console.log(out.join('\n'));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'check' && args[0]) {
    process.exit(check(args[0], args[1]));
  } else if (command === 'report') {
    const flag = args.indexOf('--days');
    process.exit(report(flag === -1 ? 30 : Number(args[flag + 1])));
  } else {
    console.error('usage: verification-stamps.mjs check <base> [head] | report [--days 30]');
    process.exit(2);
  }
}
