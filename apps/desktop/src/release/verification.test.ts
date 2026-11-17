import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

// The verification gates (docs/VERIFICATION.md): the scripts that judge a
// change, tested here beside the CI scope checks because they gate the same
// pipeline. A gate that is wrong blocks honest work or lets a bad change
// through, so each rule has a case.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const load = <T>(name: string) =>
  import(pathToFileURL(join(root, 'scripts', name)).href) as Promise<T>;

interface ChecklistItem {
  id: string;
  title: string;
  paths: RegExp[];
  added?: RegExp;
  check: string;
  source: string;
}
type Change = { path: string; lines?: string };
const { CHECKLIST, matchChecklist } = await load<{
  CHECKLIST: ChecklistItem[];
  matchChecklist(changes: Change[]): { item: ChecklistItem; paths: string[] }[];
}>('reliability-checklist.mjs');
const gate = await load<{
  parseStamp(message: string): { value: string; reason: string } | null;
  isGitCommit(command: string): boolean;
  messageReadable(command: string): boolean;
  hasEvidence(transcript: string): boolean;
  objection(command: string, transcript: string): string | null;
  decide(mode: string, blocks: number): string;
  MAX_BLOCKS: number;
}>('agent-commit-gate.mjs');
const checks = await load<{
  planChecks(
    paths: string[],
    options?: { read?: (dir: string) => string | null; exists?: (path: string) => boolean },
  ): { name: string; command?: string[]; shell?: string }[];
  decide(
    state: { rounds?: number; tree?: string | null },
    result: { failed: boolean; tree: string },
  ): { action: string; rounds?: number; state: { rounds: number; tree: string | null } };
  MAX_ROUNDS: number;
}>('agent-checks.mjs');
const api = await load<{
  breakingChanges(base: unknown, head: unknown): string[];
  judge(
    changes: string[],
    approved?: { change: string; reason: string }[],
  ): { approved: string[]; unapproved: string[]; stale: string[] };
}>('openapi-diff.mjs');
const stamps = await load<{
  stampOf(commit: { body: string }): string;
  tally(commits: { body: string }[]): Record<string, number>;
  misses(
    commits: { sha: string; at: number; subject: string }[],
    filesOf: (sha: string) => string[],
  ): { reverts: unknown[]; followUps: { fix: { sha: string }; cause: { sha: string } }[] };
}>('verification-stamps.mjs');

const scratch: string[] = [];
afterEach(() => {
  scratch.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }));
});
const ids = (changes: Change[]) => matchChecklist(changes).map(({ item }) => item.id);

describe('reliability checklist', () => {
  it('has well formed items with unique ids', () => {
    expect(new Set(CHECKLIST.map((item) => item.id)).size).toBe(CHECKLIST.length);
    for (const item of CHECKLIST) {
      expect(item.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(item.paths.length).toBeGreaterThan(0);
      for (const text of [item.title, item.check, item.source]) {
        expect(text.trim().length).toBeGreaterThan(10);
      }
    }
  });

  it('cites only files that exist', () => {
    // A check that points at a file someone moved sends its reader nowhere.
    const cited =
      /(?:^|[\s(`])((?:apps|packages|ee|docs|scripts|docker)\/[\w./-]+\.(?:ts|mjs|md|sh|json))/g;
    for (const item of CHECKLIST) {
      for (const [, path] of `${item.check} ${item.source}`.matchAll(cited)) {
        expect(existsSync(join(root, path!)), `${item.id} cites ${path}`).toBe(true);
      }
    }
  });

  it('triggers nothing for a change outside every item', () => {
    expect(ids([{ path: 'packages/avatars/src/palette.ts', lines: '+const a = 1;' }])).toEqual([]);
  });

  it('triggers the items a migration with a new table needs', () => {
    const found = ids([
      { path: 'apps/server/drizzle/0042_notes.sql', lines: '+CREATE TABLE "notes" (' },
    ]);
    expect(found).toEqual(expect.arrayContaining(['rls-new-table', 'migration-old-rows']));
  });

  it('narrows a broad path by what the diff adds', () => {
    const path = 'apps/server/src/services/bots.ts';
    expect(ids([{ path, lines: '+const name = bot.name;' }])).not.toContain('postgres-concurrency');
    expect(ids([{ path, lines: '+await db.transaction(async (tx) => {' }])).toContain(
      'postgres-concurrency',
    );
  });

  it('does not trigger on a test file alone', () => {
    expect(ids([{ path: 'packages/router/src/limits.test.ts', lines: '+it("x")' }])).toEqual([]);
    expect(ids([{ path: 'packages/router/src/limits.ts', lines: '+x' }])).toContain('bot-loops');
  });

  it('flags a change to the checks themselves, at the root or beside an app', () => {
    for (const path of [
      'REVIEW.md',
      'apps/server/REVIEW.md',
      '.claude/settings.json',
      'apps/web/.claude/skills/verify/SKILL.md',
      '.github/workflows/ci.yml',
      'scripts/reliability-checklist.mjs',
      'packages/api-client/openapi-approved-changes.json',
    ]) {
      expect(ids([{ path }]), path).toContain('checks-changed');
    }
  });

  it('reads a real diff from git', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'openbots-checklist-'));
    scratch.push(cwd);
    const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' });
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    git('commit', '-q', '--allow-empty', '-m', 'base');
    execFileSync('mkdir', ['-p', join(cwd, 'apps/relay/src')]);
    writeFileSync(join(cwd, 'apps/relay/src/frames.ts'), 'export const v = 1;\n');
    git('add', '.');
    git('commit', '-q', '-m', 'change');
    const out = execFileSync(
      'node',
      [join(root, 'scripts/reliability-checklist.mjs'), 'HEAD~1', 'HEAD'],
      { cwd, encoding: 'utf8' },
    );
    expect(out).toContain('[relay-protocol]');
    expect(out).toContain('apps/relay/src/frames.ts');
  });
});

describe('commit gate', () => {
  const ran = JSON.stringify({
    type: 'assistant',
    message: {
      content: [
        {
          type: 'tool_use',
          name: 'Bash',
          input: { command: 'bash scripts/verify-stack.sh start' },
        },
      ],
    },
  });
  const skill = JSON.stringify({
    type: 'assistant',
    message: {
      content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'apps/web:verify' } }],
    },
  });
  const onlyRead = JSON.stringify({
    type: 'user',
    message: {
      content: [{ type: 'tool_result', content: 'run bash scripts/verify-stack.sh start first' }],
    },
  });
  const commit = (trailer: string) => `git commit -m "Fix the thing\n\n${trailer}"`;

  it('reads the stamp from a message', () => {
    expect(gate.parseStamp('Subject\n\nVerified: e2e')).toEqual({ value: 'e2e', reason: '' });
    expect(gate.parseStamp('Subject\n\nverified: none: docs only')).toEqual({
      value: 'none',
      reason: 'docs only',
    });
    expect(gate.parseStamp('Subject\n\nBody says Verified in passing')).toBeNull();
  });

  it('sees a commit, and only a commit', () => {
    for (const command of [
      'git commit -m "x"',
      'git add -A && git commit -m "x"',
      'cd apps/web; git -C ../.. commit -m "x"',
    ]) {
      expect(gate.isGitCommit(command), command).toBe(true);
    }
    for (const command of ['git log', 'git commit-tree abc', 'echo "git commit"', 'gitcommit']) {
      expect(gate.isGitCommit(command), command).toBe(false);
    }
  });

  it('counts what the agent ran as evidence, not what it read', () => {
    expect(gate.hasEvidence(ran)).toBe(true);
    expect(gate.hasEvidence(skill)).toBe(true);
    expect(gate.hasEvidence(onlyRead)).toBe(false);
    expect(gate.hasEvidence('')).toBe(false);
    expect(gate.hasEvidence('not json\n{"broken"')).toBe(false);
  });

  it('objects to a missing, unknown or unexplained stamp', () => {
    expect(gate.objection('git commit -m "Fix the thing"', ran)).toMatch(/no "Verified:" trailer/);
    expect(gate.objection(commit('Verified: yes'), ran)).toMatch(/not one of/);
    expect(gate.objection(commit('Verified: none'), ran)).toMatch(/needs its reason/);
  });

  it('objects to a claim the session cannot back', () => {
    expect(gate.objection(commit('Verified: verify'), onlyRead)).toMatch(/ran no verify skill/);
    expect(gate.objection(commit('Verified: e2e'), '')).toMatch(/ran no verify skill/);
  });

  it('accepts an honest stamp', () => {
    expect(gate.objection(commit('Verified: verify'), ran)).toBeNull();
    expect(gate.objection(commit('Verified: e2e'), skill)).toBeNull();
    expect(gate.objection(commit('Verified: tests-only'), '')).toBeNull();
    expect(gate.objection(commit('Verified: none: docs only'), '')).toBeNull();
  });

  it('does not guess at a message it cannot read', () => {
    expect(gate.messageReadable('git commit -F message.txt')).toBe(false);
    expect(gate.objection('git commit -F message.txt', '')).toBeNull();
    expect(gate.objection('git commit --amend --no-edit', '')).toBeNull();
  });

  it('only logs in observe mode, and never blocks a session for ever in enforce mode', () => {
    expect(gate.decide('observe', 0)).toBe('log');
    expect(gate.decide('enforce', 0)).toBe('block');
    expect(gate.decide('enforce', gate.MAX_BLOCKS - 1)).toBe('block');
    expect(gate.decide('enforce', gate.MAX_BLOCKS)).toBe('let-through');
  });

  it('blocks as a hook with exit 2 and a reason, and says nothing for other commands', () => {
    const run = (event: object, mode: string) =>
      spawnSync('node', [join(root, 'scripts/agent-commit-gate.mjs')], {
        input: JSON.stringify(event),
        encoding: 'utf8',
        env: { ...process.env, OPENBOTS_COMMIT_GATE: mode },
      });
    const session = `test-${process.pid}-${Date.now()}`;
    const event = (command: string) => ({
      session_id: session,
      transcript_path: '/nonexistent',
      tool_name: 'Bash',
      tool_input: { command },
    });
    expect(run(event('git status'), 'enforce').status).toBe(0);
    expect(run(event('git commit -m "x"'), 'off').status).toBe(0);
    expect(run(event('git commit -m "x"'), 'observe').status).toBe(0);
    const first = run(event('git commit -m "x"'), 'enforce');
    expect(first.status).toBe(2);
    expect(first.stderr).toContain('Verified:');
    expect(run(event('git commit -m "x"'), 'enforce').status).toBe(2);
    // The third goes through: the gate can be wrong, and an agent must not be stuck.
    const third = run(event('git commit -m "x"'), 'enforce');
    expect(third.status).toBe(0);
    expect(third.stdout).toContain('let a commit through');
  });
});

describe('cheap checks', () => {
  const read = (dir: string) =>
    ({ 'apps/web': '@openbots/web', 'packages/shared': '@openbots/shared' })[dir] ?? null;
  const names = (paths: string[]) => checks.planChecks(paths, { read }).map((step) => step.name);

  it('runs nothing when nothing changed', () => {
    expect(names([])).toEqual([]);
  });

  it('only checks the format of a documentation change', () => {
    expect(names(['docs/SELF_HOSTING.md', 'apps/web/README.md'])).toEqual(['format']);
  });

  it('runs types, lint and tests for the packages that changed, and no others', () => {
    const plan = checks.planChecks(['apps/web/src/main.tsx', 'packages/shared/src/git.ts'], {
      read,
    });
    expect(plan.map((step) => step.name)).toEqual(['format', 'typecheck', 'lint', 'test']);
    for (const step of plan.slice(1)) {
      expect(step.command).toEqual(
        expect.arrayContaining(['--filter=@openbots/shared', '--filter=@openbots/web']),
      );
      expect(step.command!.filter((arg) => arg.startsWith('--filter='))).toHaveLength(2);
    }
  });

  it('regenerates the API document when a route changed', () => {
    const read = () => '@openbots/server';
    const plan = checks.planChecks(['apps/server/src/routes/bots.ts'], { read });
    expect(plan.at(-1)).toMatchObject({ name: 'openapi' });
    expect(checks.planChecks(['apps/server/src/services/bots.ts'], { read }).at(-1)!.name).toBe(
      'test',
    );
  });

  it('does not try to format a deleted file', () => {
    expect(checks.planChecks(['docs/OLD.md'], { read, exists: () => false })).toEqual([]);
  });

  it('sends a failure back for three rounds, then hands off to the person', () => {
    let state: { rounds?: number; tree?: string | null } = {};
    for (let round = 1; round <= checks.MAX_ROUNDS; round++) {
      const outcome = checks.decide(state, { failed: true, tree: 't' });
      expect(outcome).toMatchObject({ action: 'block', rounds: round });
      state = outcome.state;
    }
    const last = checks.decide(state, { failed: true, tree: 't' });
    expect(last.action).toBe('handoff');
    // Handed off on this tree: the hook does not run again until it changes.
    expect(last.state.tree).toBe('t');
  });

  it('forgets earlier failures once the checks pass', () => {
    const failed = checks.decide({}, { failed: true, tree: 'a' }).state;
    const passed = checks.decide(failed, { failed: false, tree: 'b' });
    expect(passed).toEqual({ action: 'pass', state: { rounds: 0, tree: 'b' } });
  });
});

describe('API differential check', () => {
  const doc = (operation: object, schemas: object = {}) => ({
    paths: { '/api/v1/bots': { get: operation } },
    components: { schemas },
  });
  const returns = (schema: object, extra: object = {}) => ({
    ...extra,
    responses: { 200: { content: { 'application/json': { schema } } } },
  });
  const bot = (properties: object, required: string[] = []) => ({
    type: 'object',
    properties,
    required,
  });
  const base = doc(returns({ $ref: '#/components/schemas/Bot' }), {
    Bot: bot({ id: { type: 'string' }, kind: { type: 'string', enum: ['a', 'b'] } }),
  });

  it('finds nothing between a document and itself', () => {
    expect(api.breakingChanges(base, base)).toEqual([]);
    const real = JSON.parse(readFileSync(join(root, 'packages/api-client/openapi.json'), 'utf8'));
    expect(api.breakingChanges(real, real)).toEqual([]);
  });

  it('allows additions', () => {
    const head = doc(returns({ $ref: '#/components/schemas/Bot' }), {
      Bot: bot({ id: { type: 'string' }, kind: { type: 'string', enum: ['a', 'b'] }, name: {} }),
    });
    (head.paths as Record<string, object>)['/api/v1/new'] = { get: returns({ type: 'object' }) };
    expect(api.breakingChanges(base, head)).toEqual([]);
  });

  it('reports a removed operation, a lost response field and a changed type', () => {
    expect(api.breakingChanges(base, { paths: {} })).toEqual([
      'removed operation GET /api/v1/bots',
    ]);
    const lost = doc(returns({ $ref: '#/components/schemas/Bot' }), {
      Bot: bot({ id: { type: 'integer' } }),
    });
    expect(api.breakingChanges(base, lost)).toEqual([
      'GET /api/v1/bots 200 response.id: type changed from string to integer',
      'GET /api/v1/bots 200 response: no longer returns kind',
    ]);
  });

  it('reports a response value an old client does not know', () => {
    const head = doc(returns({ $ref: '#/components/schemas/Bot' }), {
      Bot: bot({ id: { type: 'string' }, kind: { type: 'string', enum: ['a', 'b', 'c'] } }),
    });
    expect(api.breakingChanges(base, head)).toEqual([
      'GET /api/v1/bots 200 response.kind: can now be "c"',
    ]);
  });

  it('reports a request that now needs more than an old client sends', () => {
    const body = (schema: object) => ({
      requestBody: { content: { 'application/json': { schema } } },
      responses: {},
    });
    const before = doc(body(bot({ name: { type: 'string' } })));
    const after = doc({
      ...body(bot({ name: { type: 'string' }, icon: { type: 'string' } }, ['icon'])),
      parameters: [{ in: 'query', name: 'org', required: true, schema: { type: 'string' } }],
    });
    expect(api.breakingChanges(before, after)).toEqual([
      'GET /api/v1/bots: now requires query parameter org',
      'GET /api/v1/bots request: now requires icon',
    ]);
  });

  it('lets an approved change through, and notices an approval nothing uses', () => {
    const changes = ['removed operation GET /api/v1/bots'];
    expect(api.judge(changes).unapproved).toEqual(changes);
    const approved = [
      { change: changes[0]!, reason: 'never shipped in a release' },
      { change: 'removed operation GET /old', reason: 'gone' },
    ];
    expect(api.judge(changes, approved)).toEqual({
      approved: changes,
      unapproved: [],
      stale: ['removed operation GET /old'],
    });
    // An approval without a reason approves nothing.
    expect(api.judge(changes, [{ change: changes[0]!, reason: '' }]).unapproved).toEqual(changes);
  });
});

describe('verification stamps', () => {
  it('counts each kind, with none as an answer and a bare none as invalid', () => {
    const bodies = [
      'Verified: verify',
      'Verified: none: docs only',
      'Verified: none',
      'no stamp',
      '',
    ];
    expect(stamps.tally(bodies.map((body) => ({ body })))).toEqual({
      verify: 1,
      e2e: 0,
      'tests-only': 0,
      none: 1,
      invalid: 1,
      missing: 2,
    });
  });

  it('finds a fix that follows a change to the same file, nearest first', () => {
    const day = 24 * 60 * 60 * 1000;
    const commits = [
      { sha: 'import', at: 0, subject: 'Import everything' },
      { sha: 'feat', at: day, subject: 'Add the router' },
      { sha: 'other', at: 2 * day, subject: 'Touch the docs' },
      { sha: 'fix', at: 3 * day, subject: 'fix(router): stop a loop' },
      { sha: 'late', at: 60 * day, subject: 'Fix a typo long after' },
    ];
    const files: Record<string, string[]> = {
      import: Array.from({ length: 400 }, (_, i) => (i ? `f${i}.ts` : 'router.ts')),
      feat: ['router.ts'],
      other: ['README.md'],
      fix: ['router.ts'],
      late: ['router.ts'],
    };
    const { followUps } = stamps.misses(commits, (sha) => files[sha]!);
    expect(followUps.map(({ fix, cause }) => [fix.sha, cause.sha])).toEqual([['fix', 'feat']]);
  });
});

describe('where the gates are wired', () => {
  interface Workflow {
    on: Record<string, unknown>;
    permissions?: Record<string, string>;
    jobs: Record<
      string,
      {
        needs?: string[];
        if?: string;
        env?: Record<string, string>;
        steps: { name?: string; run?: string }[];
      }
    >;
  }
  const workflow = (name: string) =>
    parse(readFileSync(join(root, '.github/workflows', name), 'utf8')) as Workflow;

  it('runs the gate scripts from the base branch, and counts in the result', () => {
    const ci = workflow('ci.yml');
    const gates = ci.jobs.gates!;
    expect(gates.if).toBe("github.event_name == 'pull_request'");
    const take = gates.steps.find(
      (step) => step.name === 'Take the gate scripts from the base branch',
    )!;
    expect(take.run).toContain('git show "$base:scripts/$script.mjs"');
    for (const step of gates.steps.filter((s) => s.run?.includes('.mjs') && s !== take)) {
      // Never the checkout's own copy of a gate script.
      expect(step.run, step.name).not.toMatch(/node scripts\//);
    }
    expect(ci.jobs.result!.needs).toContain('gates');
  });

  it('starts each new gate in observe mode or says why not', () => {
    const { env } = workflow('ci.yml').jobs.gates!;
    for (const name of ['VERIFICATION_STAMPS', 'API_DIFF']) {
      expect(['observe', 'enforce']).toContain(env![name]);
    }
    const settings = JSON.parse(readFileSync(join(root, '.claude/settings.json'), 'utf8')) as {
      env: Record<string, string>;
      hooks: Record<string, { hooks: { command: string }[] }[]>;
    };
    expect(['off', 'observe', 'enforce']).toContain(settings.env.OPENBOTS_COMMIT_GATE);
    for (const [event, script] of [
      ['Stop', 'agent-checks.mjs'],
      ['PreToolUse', 'agent-commit-gate.mjs'],
    ] as const) {
      const command = settings.hooks[event]![0]!.hooks[0]!.command;
      expect(command).toContain(`$CLAUDE_PROJECT_DIR/scripts/${script}`);
      expect(existsSync(join(root, 'scripts', script))).toBe(true);
    }
  });

  it('opens the monthly review with no more than it needs', () => {
    const review = workflow('verification-review.yml');
    expect(review.on).toHaveProperty('schedule');
    expect(review.permissions).toEqual({ contents: 'read', issues: 'write' });
  });

  it('has a verify skill beside every app that ships', () => {
    for (const dir of [
      '',
      'apps/web',
      'apps/server',
      'apps/mobile',
      'apps/desktop',
      'apps/relay',
      'docker',
    ]) {
      const file = join(root, dir, '.claude/skills/verify/SKILL.md');
      expect(existsSync(file), file).toBe(true);
      expect(readFileSync(file, 'utf8')).toMatch(/^---\nname: verify\ndescription: .{40,}\n---\n/);
    }
  });

  it('keeps REVIEW.md in the shape Code Review documents, within its limits', () => {
    // https://code.claude.com/docs/en/code-review-customize
    const rootFile = readFileSync(join(root, 'REVIEW.md'), 'utf8');
    for (const heading of [
      '# Review instructions',
      '## What Important means here',
      '## Cap the nits',
      '## Do not report',
      '## Always check',
    ]) {
      expect(rootFile, heading).toContain(`${heading}\n`);
    }
    expect(rootFile).toMatch(/Report at most \w+ Nits per review\./);
    // A review cannot run a command, so the file must not ask for one.
    expect(rootFile).not.toMatch(/\b(run|execute) `?(node|pnpm|bash|git) /i);

    const beside = execFileSync('git', ['ls-files', '--', '*/REVIEW.md'], {
      cwd: root,
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean);
    expect(beside.length).toBeGreaterThan(0);
    // Directory names under which Code Review applies no REVIEW.md.
    const ignored = new Set(
      (
        'test tests __tests__ testdata fixtures __fixtures__ golden corpus snapshots __snapshots__ ' +
        'example examples sample samples demo demos generated vendor third_party third-party ' +
        'thirdparty node_modules bower_components external extern deps godeps pods carthage ' +
        'site-packages contrib'
      ).split(' '),
    );
    let bytes = 0;
    let links = (rootFile.match(/\]\((?!https?:|mailto:|#)/g) ?? []).length;
    for (const file of beside) {
      const text = readFileSync(join(root, file), 'utf8');
      expect(text, file).toMatch(/^# Review instructions/);
      expect(text, file).toContain('## Always check\n');
      for (const part of dirname(file).split('/')) {
        expect(ignored.has(part.toLowerCase()), `${file} is under ${part}`).toBe(false);
      }
      // An include line works only in the root file.
      expect(text, file).not.toMatch(/^@\S+$/m);
      bytes += Buffer.byteLength(text);
      links += (text.match(/\]\((?!https?:|mailto:|#)/g) ?? []).length;
    }
    expect(Buffer.byteLength(rootFile)).toBeLessThan(150_000);
    expect(bytes).toBeLessThan(150_000);
    expect(links).toBeLessThanOrEqual(64);
  });

  it('skips only generated files that exist', () => {
    const rootFile = readFileSync(join(root, 'REVIEW.md'), 'utf8');
    const section = rootFile.slice(
      rootFile.indexOf('## Do not report'),
      rootFile.indexOf('## Require'),
    );
    const line = section.split('\n- ').find((item) => item.startsWith('Generated files'))!;
    const paths = [...line.matchAll(/`([^`]+)`/g)].map((match) => match[1]!);
    expect(paths.length).toBeGreaterThan(3);
    for (const path of paths) expect(existsSync(join(root, path)), path).toBe(true);
  });

  it('names every protected path in CODEOWNERS', () => {
    const owners = readFileSync(join(root, '.github/CODEOWNERS'), 'utf8');
    for (const path of [
      '/REVIEW.md',
      '**/REVIEW.md',
      '/CLAUDE.md',
      '/.claude/',
      '**/.claude/',
      '/.github/',
      '/scripts/agent-commit-gate.mjs',
      '/scripts/reliability-checklist.mjs',
      '/scripts/openapi-diff.mjs',
      '/packages/api-client/openapi-approved-changes.json',
    ]) {
      expect(owners, path).toMatch(new RegExp(`^${path.replace(/[.*/]/g, '\\$&')}\\s+@`, 'm'));
    }
  });
});
