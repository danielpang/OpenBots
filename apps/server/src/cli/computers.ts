import { inWorkspace } from '../db/scope.js';
import { DomainError } from '../errors.js';
import {
  listRetiredComputers,
  retryRetiredComputer,
  type RetiredRow,
} from '../services/computer-retire.js';
import { ensureWorkspace } from '../workspace.js';
import type { CliContext, CliResult } from './context.js';

// `openbots computers retired | retry` (plan 9.5): the old machines of full
// resets that are not deleted yet (services/computer-retire.ts), and the
// retry of one the retired-computers job gave up on. `retired --gave-up`
// lists only those waiting for an operator. There is no route or screen for
// this: only an operator with the server's database can do it. The CLI has
// no sign-in, so a retry names its operator with `--by` (a name or email,
// recorded as given); it is audited by the system with that name as
// `operator`.

export const COMPUTERS_USAGE = [
  'usage: openbots computers retired [--gave-up] [--org <organization id>]',
  '       openbots computers retry <retired id> --by <your name> [--org <organization id>]',
  '--org is required on the managed service; a self-hosted install has one organization.',
  '--by names the operator in the audit log.',
].join('\n');

/** An operator's name for the audit log: printable, short. */
const OPERATOR = /^[^\p{C}]{1,200}$/u;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Flags that take no value. */
const SWITCHES = ['--gave-up'];

/** `--name value` pairs (a switch alone), and the rest, in order. */
function parse(args: string[]): { flags: Map<string, string>; rest: string[] } | null {
  const flags = new Map<string, string>();
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (SWITCHES.includes(arg)) {
      if (flags.has(arg)) return null;
      flags.set(arg, '');
    } else if (arg.startsWith('--')) {
      const value = args[++i];
      if (value === undefined || flags.has(arg)) return null;
      flags.set(arg, value);
    } else rest.push(arg);
  }
  return { flags, rest };
}

function line(row: RetiredRow): string {
  return [
    row.id,
    `member ${row.ownerId}`,
    `reset ${row.retiredAt.toISOString()}`,
    `attempts ${row.attempts}`,
    row.gaveUpAt
      ? `gave up ${row.gaveUpAt.toISOString()}, waiting for an operator (computers retry)`
      : `next attempt ${row.nextAttemptAt?.toISOString() ?? 'now'}`,
    ...(row.lastError ? [`last error: ${row.lastError}`] : []),
  ].join('  ');
}

export async function runComputers(args: string[], ctx: CliContext): CliResult {
  const { db, config, write } = ctx;
  const [command, ...more] = args;
  const parsed = parse(more);
  const known = ['--org', '--by', ...SWITCHES];
  if (
    !parsed ||
    !['retired', 'retry'].includes(command ?? '') ||
    [...parsed.flags.keys()].some((flag) => !known.includes(flag))
  ) {
    write(COMPUTERS_USAGE);
    return 2;
  }
  const { flags, rest } = parsed;
  let workspaceId = flags.get('--org');
  if (!workspaceId) {
    if (config.deployment !== 'self_hosted') {
      write('computers: name the organization with --org on the managed service');
      return 2;
    }
    workspaceId = (await ensureWorkspace(db)).id;
  }
  if (!UUID.test(workspaceId)) {
    write(`computers: no organization ${workspaceId}`);
    return 1;
  }
  const org = workspaceId;

  if (command === 'retired') {
    if (flags.has('--by') || rest.length) {
      write(COMPUTERS_USAGE);
      return 2;
    }
    const gaveUp = flags.has('--gave-up');
    const rows = await inWorkspace(org, () =>
      listRetiredComputers(db, { workspaceId: org, gaveUp }),
    );
    if (!rows.length) {
      write(
        gaveUp
          ? 'No old computers are waiting for an operator.'
          : 'No old computers are waiting to be deleted.',
      );
      return 0;
    }
    for (const row of rows) write(line(row));
    return 0;
  }

  const [id, ...extra] = rest;
  const operator = flags.get('--by')?.trim();
  if (!id || extra.length || flags.has('--gave-up') || !operator) {
    write(COMPUTERS_USAGE);
    return 2;
  }
  if (!OPERATOR.test(operator)) {
    write('computers: --by takes a name of up to 200 printable characters');
    return 2;
  }
  if (!UUID.test(id)) {
    write(`computers: no retired computer ${id}`);
    return 1;
  }
  try {
    const row = await inWorkspace(org, () =>
      retryRetiredComputer({ db }, { workspaceId: org, retiredId: id }, operator),
    );
    write(`Retrying ${row.id}: the retired-computers job deletes it at its next sweep.`);
    return 0;
  } catch (error) {
    if (error instanceof DomainError && error.status === 409) {
      write(`computers: ${error.message}`);
      return 1;
    }
    throw error;
  }
}
