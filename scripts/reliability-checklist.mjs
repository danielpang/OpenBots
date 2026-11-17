#!/usr/bin/env node
// The reliability checklist: things that have broken OpenBots before, or that
// its design says must hold, each with a trigger that can be read from a
// diff. Nobody has to remember the list: this script reads the diff and
// prints only the items whose trigger matches, usually a handful.
//
//   node scripts/reliability-checklist.mjs                 # this branch against origin/main
//   node scripts/reliability-checklist.mjs <base> [head]   # two commits
//   node scripts/reliability-checklist.mjs --all           # every item
//
// The reliability-check skill (.claude/skills/reliability-check) runs it
// before a pull request, and REVIEW.md has the reviewer run it on the diff.
//
// An item is:
//   id       short and stable; reviews and commit messages cite it
//   title    what must hold, as a sentence
//   paths    regular expressions on changed paths; any match triggers the item
//   added    optional: a regular expression that must also match a line the
//            diff adds or removes in those paths (narrows a broad path)
//   check    what to do, concretely: a command to run or a question to answer
//   source   the incident, pull request, test or document behind it
//   tests    optional: true when a change to a test file alone triggers it
//            (by default a test or spec file triggers nothing)
//
// Adding an item: it must have gone wrong (or nearly) in at least one pull
// request, and the trigger must be readable from a diff. Removing one: when
// a test or a type now makes the mistake impossible, say so in the commit.
// docs/VERIFICATION.md says how misses become items and how the list is pruned.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const CHECKLIST = [
  {
    id: 'rls-new-table',
    title: 'A table that holds an organization’s data is behind row-level security',
    paths: [/^apps\/server\/drizzle\/.*\.sql$/, /^apps\/server\/src\/db\/schema\//],
    added: /create table|pgTable\(/i,
    check:
      'Does the new table carry workspace_id and a policy? Add it to apps/server/src/db/rls.test.ts and a cross-user case to apps/server/src/routes/ownership.test.ts, then run both on real Postgres (PGlite has no app role).',
    source: 'U2 in docs/plans/TRACEABILITY.md; apps/server/src/db/rls.test.ts',
  },
  {
    id: 'migration-old-rows',
    title: 'A migration works on a database that already has rows',
    paths: [/^apps\/server\/drizzle\//],
    check:
      'Is every new column nullable or defaulted, and does a backfill cover existing rows? Never edit a migration that has shipped: add a new one. Run apps/server/src/db/migrations.test.ts, which migrates data forward.',
    source:
      'apps/server/src/db/migrations.test.ts; the standalone image restarts on its old volume',
  },
  {
    id: 'postgres-concurrency',
    title: 'A query, transaction or worker is correct with queries running side by side',
    paths: [
      /^apps\/server\/src\/(services|workers|infra|db)\/.*(?<!\.test)\.ts$/,
      /^ee\/server\/src\/.*(?<!\.test)\.ts$/,
    ],
    added: /\.transaction\(|for update|on conflict|advisory|\.insert\(|\.update\(|\.delete\(/i,
    check:
      'Run the server tests on real Postgres: DATABASE_URL=postgres://openbots:openbots@127.0.0.1:5432/openbots pnpm turbo run test --filter @openbots/server. PGlite runs one query at a time and hides races.',
    source: 'docs/CONTRIBUTING.md, "What a change includes"; CI job server-postgres',
  },
  {
    id: 'pglite-case-folding',
    title: 'Text is not compared with lower() or ILIKE where it can be non-ASCII',
    paths: [/^apps\/server\/src\/.*\.ts$/, /^ee\/server\/src\/.*\.ts$/],
    added: /\blower\(|\bupper\(|ilike/i,
    check:
      'PGlite folds case for ASCII only, so its tests cannot show what the server does with other letters. Fold in code, or add a case to the server-postgres run.',
    source: 'apps/server/src/db/differential.test.ts, which found the difference',
  },
  {
    id: 'openapi-current',
    title: 'The OpenAPI document and the generated client match the routes',
    paths: [/^apps\/server\/src\/routes\//, /^apps\/server\/src\/openapi/],
    check:
      'pnpm --filter @openbots/server openapi && pnpm exec prettier --write packages/api-client/openapi.json && pnpm --filter @openbots/api-client generate, then commit packages/api-client.',
    source: 'CI step "Check the OpenAPI document and client are current"',
  },
  {
    id: 'openapi-managed',
    title: 'The managed OpenAPI document and ee/web’s types match the managed routes',
    paths: [/^ee\/server\/src\//],
    check:
      'pnpm --filter @openbots/ee-server openapi && pnpm exec prettier --write ee/server/openapi.json && pnpm --filter @openbots/ee-web generate, then commit both files.',
    source: 'CI step "Check the managed OpenAPI document and types are current"',
  },
  {
    id: 'api-old-clients',
    title: 'An API change does not break an app that is already installed',
    paths: [/^packages\/api-client\/openapi\.json$/, /^apps\/server\/src\/routes\//],
    check:
      'The iOS and Mac apps update on their own schedule, so the server must keep answering the last release. Run node scripts/openapi-diff.mjs against main: a removed operation or response field, or a new required input, needs a deprecation path or an entry in packages/api-client/openapi-approved-changes.json with the reason.',
    source:
      'apps/mobile and apps/desktop ship separately from the server (docs/CONTRIBUTING.md, Releases)',
  },
  {
    id: 'stored-parts-load',
    title: 'Stored messages and events written before the change still load',
    paths: [/^packages\/shared\/src\/(parts|events|artifacts|routines|policy)\.ts$/],
    check:
      'Rows in messages.parts and settings columns were written by older code and will not have a new field. Is every new field optional or defaulted on read, and are unknown part types still tolerated (the schemas are loose objects on purpose)? Add a test that parses a row in the old shape.',
    source:
      'packages/shared/src/parts.ts; the same class of bug as an old transcript failing to resume',
  },
  {
    id: 'tool-history-replay',
    title: 'Replayed tool history is still a conversation a provider accepts',
    paths: [/^packages\/agent\/src\/(run|context)\//, /^packages\/models\/src\//],
    check:
      'Every tool result must follow its tool call, with matching ids and valid names, after pruning, compaction or a resume. Run packages/agent’s run and context tests, and try a resumed run with a pending approval in the browser.',
    source:
      'a9b1752 Fix 400s from replayed tool history (#35); 6784ab6 Fix resuming after a question or approval (#38)',
  },
  {
    id: 'prompt-cache-prefix',
    title: 'The start of the prompt stays byte-identical between turns',
    paths: [/^packages\/agent\/src\/context\//, /^apps\/server\/src\/services\/.*(prompt|context)/],
    check:
      'Anything that varies per turn (a timestamp, a count, reordered tools or skills) before the cache breakpoint silently ends prompt caching. Compare the assembled prefix across two turns; the cache tests in packages/agent say where the breakpoints are.',
    source: 'a8e5148 Prompt caching: cache the conversation within a run and between runs (#49)',
  },
  {
    id: 'bot-loops',
    title: 'Bots cannot answer each other without end',
    paths: [/^packages\/router\/src\//, /^apps\/server\/src\/services\/.*(route|router|dispatch)/],
    check:
      'Does every new way to start a run pass through withinChainLimits with the right depth and botTriggered? Run packages/router’s tests, including limits.property.test.ts, and the groups spec in apps/web/e2e.',
    source: '794596f keep Bot-to-Bot chains in groups tight and owner-led (#18); 06784cc (#16)',
  },
  {
    id: 'policy-never-looser',
    title: 'A webhook or another Bot can never make a tool run with less asking',
    paths: [
      /^packages\/agent\/src\/policy\//,
      /^packages\/shared\/src\/policy\.ts$/,
      /^apps\/server\/src\/hooks\//,
    ],
    check:
      'Trigger overrides only raise a decision, and data from a webhook or a Bot is never an instruction (P2). Run packages/agent/src/policy, including engine.property.test.ts. A new tool with side effects needs a default rule that asks.',
    source:
      'PRD P2; packages/agent/src/policy/engine.property.test.ts, which found a lookup by tool name reaching inherited properties',
  },
  {
    id: 'new-tool-default',
    title: 'A new tool has a default decision and a group',
    paths: [/^packages\/agent\/src\/tools\//, /^apps\/server\/src\/builtins\//],
    added: /name:\s*['"`]|toolName|defineTool|registerTool/,
    check:
      'A tool the policy does not know is judged by its name alone. Add it to NAMED_RULES in packages/agent/src/policy/rules.ts if it changes anything, and to the Bot Settings summary.',
    source: 'packages/agent/src/policy/rules.ts',
  },
  {
    id: 'webhook-ingress',
    title: 'A webhook is verified, rate limited and size limited before its body is used',
    paths: [/^apps\/server\/src\/hooks\//, /^apps\/server\/src\/routes\/.*webhook/],
    check:
      'Is the signature checked on the raw body, in constant time, before parsing? Do the per-address and failed-verification limits still apply on the new path? Run apps/server/src/hooks/verify.test.ts.',
    source: 'PRD H3, H4; packages/shared/src/limits.ts',
  },
  {
    id: 'secrets-in-logs',
    title: 'No secret, token or message text reaches a log line or an error',
    paths: [/^apps\/(server|relay|computer-agent)\/src\/.*(?<!\.test)\.ts$/, /^ee\/server\/src\//],
    added: /logger\.|console\.|log\.(info|warn|error|debug)\(/,
    check:
      'Read each new log call: does it pass a request, a header set, a connector config, a token or a message body? Log the id and the outcome instead.',
    source: 'docs/SELF_HOSTING.md; PostHog relay metrics are anonymous by design (82b9498, #44)',
  },
  {
    id: 'secret-storage',
    title: 'Stored secrets stay encrypted under the master key and survive a rotation',
    paths: [
      /^apps\/server\/src\/(rotate-key|keygen)\.ts$/,
      /^apps\/server\/src\/.*(secret|crypto|vault)/i,
    ],
    check:
      'Is the new secret encrypted with the master key, and does rotate-key re-encrypt it? Run apps/server/src/rotation.test.ts, then backup and restore.',
    source: 'apps/server/src/rotation.test.ts; docs/plans/RELEASE_CHECKS.md step 12',
  },
  {
    id: 'relay-protocol',
    title: 'A relay or tunnel change keeps version 1 clients working',
    paths: [/^apps\/relay\/src\//, /^packages\/tunnel\/src\//, /^docs\/RELAY_PROTOCOL\.md$/],
    check:
      'Phones in the field speak the protocol they shipped with. A change a version 1 client cannot read needs v2, not an edit to v1 (docs/RELAY_PROTOCOL.md). Update the document in the same change and run apps/relay and packages/tunnel tests.',
    source: 'docs/RELAY_PROTOCOL.md: "a change that breaks a client gets v2"',
  },
  {
    id: 'container-hardening',
    title: 'The docker guard, the sandbox firewall and the compose files still isolate computers',
    paths: [
      /^docker\//,
      /^compose\.yaml$/,
      /^packages\/computer\/src\//,
      /^apps\/computer-agent\/src\//,
    ],
    check:
      'On a Docker host, run the steps of docs/plans/RELEASE_CHECKS.md that the change touches (guard refusals, network isolation from inside a computer, metrics token). The unit tests check the rules without Docker; they cannot show the firewall.',
    source: 'docs/plans/RELEASE_CHECKS.md, "Checking the container hardening"',
  },
  {
    id: 'standalone-lifecycle',
    title: 'The standalone image still boots, backs up, restores and restarts on its volume',
    paths: [/^docker\/standalone/, /^scripts\/(backup|restore)\.sh$/, /^install\.sh$/],
    check:
      'bash docker/standalone/test/init-lib.test.sh and shellcheck locally; the CI job standalone-image runs the lifecycle. Does a volume from the last release still start?',
    source: 'CI job standalone-image',
  },
  {
    id: 'settings-documented',
    title: 'A new setting is in .env.example and the self-hosting reference',
    paths: [/^apps\/(server|relay)\/src\/config\.ts$/, /^\.env\.example$/],
    check:
      'Add the variable to .env.example with its default and to docs/SELF_HOSTING.md. Run apps/server/src/env-example.test.ts. Does an install that does not set it behave as before?',
    source: 'docs/CONTRIBUTING.md; apps/server/src/env-example.test.ts',
  },
  {
    id: 'coding-agent-vendors',
    title: 'A coding session change works for Claude Code, Codex and pi',
    paths: [/^apps\/server\/src\/services\/(coder|coding)/, /^packages\/shared\/src\/coder/],
    check:
      'Each vendor has its own adapter, transcript shape and approval bridge. Is there a fixture and a test for each of the three, and do pushes and pull requests still ask?',
    source:
      '8816920 Fix coding-session UX and add trusted automatic PR publishing (#41); docs/plans/CODING_AGENT_VENDORS.md',
  },
  {
    id: 'mobile-released-app',
    title: 'A mobile change keeps sessions, pairing and reconnection working',
    paths: [/^apps\/mobile\/src\/(api|transport|hosts|cache|push)\//, /^apps\/mobile\/app\//],
    check:
      'pnpm --filter @openbots/mobile test and check:sdk, then on a simulator: sign in, background the app, come back, and confirm the transcript resyncs without duplicates (apps/mobile/DEVICE-VALIDATION.md).',
    source:
      '271778d Fix mobile session refresh and add silent background reconnection (#31); 13beb3f (#27)',
  },
  {
    id: 'release-toolchain-pins',
    title: 'Release toolchains stay pinned',
    paths: [
      /^apps\/mobile\/(eas\.json|app\.config\.ts)$/,
      /^\.github\/workflows\/release/,
      /^scripts\/release/,
    ],
    check:
      'Is the EAS image, Xcode and Node version still pinned, and does node scripts/release-version.mjs check pass? Release workflows only run on a tag, so a mistake here shows at the worst time.',
    source: '62aa4fa fix(mobile): pin the iOS EAS build toolchain and project (#23)',
  },
  {
    id: 'dependency-added',
    title: 'A new dependency is licensed, audited and old enough',
    paths: [/package\.json$/, /^pnpm-workspace\.yaml$/, /^pnpm-lock\.yaml$/],
    added: /^[+-]\s+['"@a-z]/,
    check:
      'node scripts/check-licenses.mjs and pnpm audit. Shared versions go in the catalog in pnpm-workspace.yaml. Core packages must never import from ee/.',
    source: 'scripts/check-licenses.mjs; plan 18.9',
  },
  {
    id: 'ci-scope-covers-path',
    title: 'A new top-level path or app is mapped to the CI jobs that test it',
    paths: [
      /^scripts\/ci-scope\.mjs$/,
      /^\.github\/workflows\/ci\.yml$/,
      /^[^/]+\/[^/]+\/package\.json$/,
    ],
    added: /^\+\s*"name":|ci-scope|needs\.scope/m,
    check:
      'Add the path to scripts/ci-scope.mjs and a case to apps/desktop/src/release/ci.test.ts. A path the script does not know runs everything, which is safe but slow; a path mapped to too little skips its tests.',
    source: 'docs/CONTRIBUTING.md, "CI scope and build reuse"',
  },
  {
    id: 'writing-style',
    title: 'User-facing text uses plain sentences without dashes as pauses',
    paths: [/^apps\/(web|desktop|mobile)\/(src|app)\/.*\.tsx$/, /^ee\/web\/src\/.*\.tsx$/, /\.md$/],
    added: /[–—]| - [a-z]/,
    check:
      'No em or en dash, and no hyphen as a pause: write two sentences, or use a comma or a colon.',
    source: 'docs/CONTRIBUTING.md, "Writing"',
  },
  {
    id: 'traceability-row',
    title: 'The PRD requirement a change touches has a current row',
    paths: [
      /^docs\/plans\/PRD\.md$/,
      /^apps\/server\/src\/routes\//,
      /^apps\/web\/src\/features\//,
    ],
    added: /\b[A-Z]{1,2}\d{1,2}\b/,
    check:
      'Update the rows of docs/plans/TRACEABILITY.md for the PRD IDs in the commit subject: the code path, and the title of a test that exists as written.',
    source: 'docs/CONTRIBUTING.md, "What a change includes"',
  },
  {
    id: 'checks-changed',
    title: 'A change to the checks themselves is reviewed as one',
    paths: [
      /^REVIEW\.md$/,
      /^CLAUDE\.md$/,
      /^\.claude\//,
      /\/\.claude\//,
      /^\.github\/(workflows\/|CODEOWNERS$)/,
      /^scripts\/(reliability-checklist|openapi-diff|verification-stamps|agent-checks|agent-commit-gate|ci-scope)\.mjs$/,
      /openapi-approved-changes\.json$/,
    ],
    check:
      'A change must not loosen the check that judges it. Say in the pull request what the check allowed before and allows now, and why. CI runs the gate scripts from the base branch; a code owner reviews the rest.',
    source: 'docs/VERIFICATION.md, "Protected checks"',
  },
];

const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

/**
 * The items whose trigger matches. `changes` is a list of `{ path, lines }`,
 * `lines` being the text the diff adds or removes in that path (may be empty).
 */
export function matchChecklist(changes, checklist = CHECKLIST) {
  const matches = [];
  for (const item of checklist) {
    const hits = changes.filter(
      ({ path, lines = '' }) =>
        (item.tests || !TEST_FILE.test(path)) &&
        item.paths.some((pattern) => pattern.test(path)) &&
        (!item.added || item.added.test(lines)),
    );
    if (hits.length) matches.push({ item, paths: hits.map((hit) => hit.path) });
  }
  return matches;
}

const git = (...args) =>
  execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

/** Changed paths between two commits (or a commit and the working tree), with their changed lines. */
export function changesBetween(base, head) {
  const range = head ? [base, head] : [base];
  const names = git('diff', '--name-only', '--no-renames', '-z', ...range)
    .split('\0')
    .filter(Boolean);
  const untracked = head
    ? []
    : git('ls-files', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean);
  const changes = new Map([...names, ...untracked].map((path) => [path, []]));
  let current = null;
  for (const line of git('diff', '--no-renames', '--unified=0', ...range).split('\n')) {
    if (line.startsWith('+++ ') || line.startsWith('--- ')) {
      const path = line.slice(4).replace(/^[ab]\//, '');
      if (path !== '/dev/null' && changes.has(path)) current = changes.get(path);
    } else if (current && /^[+-]/.test(line)) {
      current.push(line);
    }
  }
  return [...changes].map(([path, lines]) => ({ path, lines: lines.join('\n') }));
}

/** The commit this branch left the default branch at; null when it cannot be found. */
export function defaultBase() {
  for (const ref of ['origin/main', 'main']) {
    try {
      return git('merge-base', ref, 'HEAD').trim();
    } catch {
      // Try the next name.
    }
  }
  return null;
}

export function formatMatches(matches) {
  if (!matches.length) return 'No reliability checklist item is triggered by this diff.\n';
  const out = [
    `${matches.length} of ${CHECKLIST.length} reliability checklist items are triggered by this diff.\n`,
  ];
  for (const { item, paths } of matches) {
    const shown =
      paths.slice(0, 3).join(', ') + (paths.length > 3 ? `, and ${paths.length - 3} more` : '');
    out.push(`[${item.id}] ${item.title}`);
    out.push(`  Triggered by: ${shown}`);
    out.push(`  Check: ${item.check}`);
    out.push(`  Behind it: ${item.source}\n`);
  }
  return out.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.includes('--all')) {
    process.stdout.write(formatMatches(CHECKLIST.map((item) => ({ item, paths: ['--all'] }))));
  } else {
    const base = args[0] ?? defaultBase();
    if (!base) {
      console.error('reliability-checklist: no base commit; pass one, or fetch origin/main');
      process.exit(2);
    }
    process.stdout.write(formatMatches(matchChecklist(changesBetween(base, args[1]))));
  }
}
