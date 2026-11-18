#!/usr/bin/env node
// The commit gate: a PreToolUse hook (.claude/settings.json) that looks at
// each `git commit` a coding agent is about to run and asks one question:
// does this commit say how it was verified, and did that happen?
//
// Every commit carries a trailer (docs/VERIFICATION.md, "The stamp"):
//
//   Verified: verify            ran a verify skill: the change, running
//   Verified: e2e               ran the browser or device specs for it
//   Verified: tests-only        unit, property or differential tests only
//   Verified: none: <reason>    not verified, and why (docs only, say)
//
// `verify` and `e2e` are claims, so the gate looks for the evidence in the
// session: a verify or code-review skill, the stack script, or Playwright.
//
// OPENBOTS_COMMIT_GATE picks the mode (set in .claude/settings.json):
//   off      does nothing
//   observe  never blocks; logs what it would have blocked to
//            .verify/commit-gate.log, so false positives can be read first
//   enforce  blocks the commit and says what is missing. After two blocks in
//            a session the next commit goes through, logged, so an agent is
//            never stuck behind a gate that is wrong.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const MAX_BLOCKS = 2;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LOG_FILE = join(ROOT, '.verify', 'commit-gate.log');
const STATE_FILE = join(ROOT, '.verify', 'commit-gate.json');

export const STAMPS = ['verify', 'e2e', 'tests-only', 'none'];
// The message can arrive inside a shell command, so the line may be indented
// (a heredoc) or end with the quote that closes -m "...".
const TRAILER = /^[ \t]*Verified:[ \t]*([a-z0-9-]+)[ \t]*(?::[ \t]*(.*?))?[ \t]*["')]*[ \t]*$/im;

/** The `Verified:` trailer of a commit message: `{ value, reason }`, or null. */
export function parseStamp(message) {
  const match = TRAILER.exec(message ?? '');
  if (!match) return null;
  return { value: match[1].toLowerCase(), reason: (match[2] ?? '').trim() };
}

/** Whether a shell command runs `git commit` (not `git commit-tree`, not a mention in a string). */
export function isGitCommit(command) {
  return /(^|[;&|(\n]\s*)git\s+(?:-[^\s]+\s+(?:\S+\s+)?)*commit(\s|$)/.test(command ?? '');
}

/**
 * Whether the message can be read from the command. With `-F file`, `-C`,
 * `--no-edit` or an editor it cannot, and the gate does not guess.
 */
export function messageReadable(command) {
  return (
    /\s(-[a-zA-Z]*m|--message)[\s=]/.test(command) &&
    !/\s(-F|--file|-C|-c|--no-edit)\b/.test(command)
  );
}

const VERIFY_SKILL = /(^|[:/])(verify|code-review|reliability-check)$/;
const VERIFY_COMMAND = /scripts\/verify-stack\.sh\s+start|playwright\s+test|maestro\s+test/;

/**
 * Whether a session verified something: its transcript (JSON lines) holds a
 * call of a verify or review skill, or a command that boots the stack or
 * runs the browser or device specs. Only what the agent ran counts, so a
 * file that mentions those commands is not evidence.
 */
export function hasEvidence(transcript) {
  for (const line of (transcript ?? '').split('\n')) {
    if (!line.includes('"tool_use"') && !line.includes('<command-name>')) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const content = entry?.message?.content;
    if (typeof content === 'string') {
      // A slash command the person typed, such as /verify.
      if (
        entry.type === 'user' &&
        /<command-name>\/?[\w:/-]*(verify|code-review)\b/.test(content)
      ) {
        return true;
      }
      continue;
    }
    for (const part of Array.isArray(content) ? content : []) {
      if (part?.type !== 'tool_use') continue;
      if (part.name === 'Skill' && VERIFY_SKILL.test(String(part.input?.skill ?? ''))) return true;
      if (part.name === 'Bash' && VERIFY_COMMAND.test(String(part.input?.command ?? '')))
        return true;
    }
  }
  return false;
}

/**
 * The gate's judgement of one commit command: null when there is nothing to
 * object to, else the reason in a sentence.
 */
export function objection(command, transcript) {
  if (!messageReadable(command)) return null;
  const stamp = parseStamp(command);
  if (!stamp) {
    return 'The commit message has no "Verified:" trailer saying how the change was verified.';
  }
  if (!STAMPS.includes(stamp.value)) {
    return `"Verified: ${stamp.value}" is not one of ${STAMPS.join(', ')}.`;
  }
  if (stamp.value === 'none' && !stamp.reason) {
    return '"Verified: none" needs its reason after a colon, for example "Verified: none: docs only".';
  }
  if ((stamp.value === 'verify' || stamp.value === 'e2e') && !hasEvidence(transcript)) {
    return `The message says "Verified: ${stamp.value}", but this session ran no verify skill, stack or browser spec.`;
  }
  return null;
}

/** What to do with an objection in a mode, given how often this session was blocked. */
export function decide(mode, blocks) {
  if (mode !== 'enforce') return 'log';
  return blocks >= MAX_BLOCKS ? 'let-through' : 'block';
}

const HELP = `
Run the verify skill for what you changed (.claude/skills/verify), then end the
commit message with one trailer line:

  Verified: verify | e2e | tests-only | none: <reason>

A change that cannot be verified here still commits: say so with
"Verified: none: <reason>". docs/VERIFICATION.md has the details.`;

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function main() {
  const mode = process.env.OPENBOTS_COMMIT_GATE ?? 'observe';
  if (mode === 'off') return 0;
  const event = readJson(0, null);
  const command = event?.tool_input?.command;
  if (event?.tool_name !== 'Bash' || !isGitCommit(command)) return 0;

  let transcript = '';
  try {
    transcript = readFileSync(event.transcript_path, 'utf8');
  } catch {
    // No transcript to read: claims of verify or e2e cannot be confirmed.
  }
  const reason = objection(command, transcript);
  if (!reason) return 0;

  const session = event.session_id ?? 'unknown';
  const state = readJson(STATE_FILE, {});
  const blocks = state[session] ?? 0;
  const action = decide(mode, blocks);
  mkdirSync(dirname(LOG_FILE), { recursive: true });
  appendFileSync(
    LOG_FILE,
    `${JSON.stringify({ at: new Date().toISOString(), mode, action, session, reason, command: command.slice(0, 400) })}\n`,
  );
  if (action === 'log') return 0;
  if (action === 'let-through') {
    process.stdout.write(
      JSON.stringify({
        systemMessage: `Commit gate: let a commit through after ${MAX_BLOCKS} blocks. ${reason}`,
      }),
    );
    return 0;
  }
  writeFileSync(STATE_FILE, JSON.stringify({ ...state, [session]: blocks + 1 }, null, 2));
  console.error(`Commit gate: ${reason}\n${HELP}`);
  return 2; // Exit 2 from a PreToolUse hook blocks the call and shows stderr to the agent.
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
