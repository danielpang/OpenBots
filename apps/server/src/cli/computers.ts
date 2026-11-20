import { and, eq } from 'drizzle-orm';
import { schema } from '../db/client.js';
import { asDirectory, inWorkspace } from '../db/scope.js';
import { DomainError } from '../errors.js';
import { createLogger } from '../logger.js';
import { SYSTEM_ACTOR } from '../services/audit.js';
import { computerProvider } from '../services/computer.js';
import {
  listRetiredComputers,
  restoreRetiredComputer,
  type RetiredRow,
} from '../services/computer-retire.js';
import { ensureWorkspace } from '../workspace.js';
import type { CliContext, CliResult } from './context.js';

// `openbots computers retired | restore` (plan 9.5): support's view of a
// member's retired computers, the old machines a reset that forgot the
// sign-ins keeps for seven days, and the restore that makes one the member's
// computer again (services/computer-retire.ts). There is no route or screen
// for this: only an operator with the server's database and provider token
// can do it. Every restore is audited as `computer.restore`, by the system.

export const COMPUTERS_USAGE = [
  'usage: openbots computers retired --member <email or user id> [--org <organization id>]',
  '       openbots computers restore <retired id> [--org <organization id>]',
  '--org is required on the managed service; a self-hosted install has one organization.',
].join('\n');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `--name value` pairs and the rest, in order. */
function parse(args: string[]): { flags: Map<string, string>; rest: string[] } | null {
  const flags = new Map<string, string>();
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith('--')) {
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
    row.status,
    `retired ${row.retiredAt.toISOString()}`,
    row.status === 'deleted'
      ? `deleted ${row.deletedAt?.toISOString() ?? ''}`
      : row.status === 'restored'
        ? `restored ${row.restoredAt?.toISOString() ?? ''}`
        : `deleted after ${row.deleteAfter.toISOString()}`,
    `checkpoint ${row.checkpointId ?? 'none'}`,
    ...(row.lastError ? [`last error: ${row.lastError}`] : []),
  ].join('  ');
}

export async function runComputers(args: string[], ctx: CliContext): CliResult {
  const { db, config, write } = ctx;
  const [command, ...more] = args;
  const parsed = parse(more);
  const known = ['--org', '--member'];
  if (
    !parsed ||
    !['retired', 'restore'].includes(command ?? '') ||
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
    const member = flags.get('--member');
    if (!member || rest.length) {
      write(COMPUTERS_USAGE);
      return 2;
    }
    // The account by its id or email (the directory's), then its membership here.
    const [user] = await asDirectory(() =>
      db
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(
          UUID.test(member)
            ? eq(schema.users.id, member)
            : eq(schema.users.email, member.toLowerCase()),
        ),
    );
    const [membership] = user
      ? await inWorkspace(org, () =>
          db
            .select({ id: schema.workspaceMembers.id })
            .from(schema.workspaceMembers)
            .where(
              and(
                eq(schema.workspaceMembers.workspaceId, org),
                eq(schema.workspaceMembers.userId, user.id),
              ),
            ),
        )
      : [];
    if (!user) {
      write(`computers: no member ${member}`);
      return 1;
    }
    // A removed member's rows are still listed: they are what support may be asked about.
    const rows = await inWorkspace(org, () =>
      listRetiredComputers(db, { workspaceId: org, ownerId: user.id }),
    );
    if (!membership) write(`${member} is not a member of this organization now.`);
    if (!rows.length) {
      write('No retired computers.');
      return 0;
    }
    for (const row of rows) write(line(row));
    return 0;
  }

  const [id, ...extra] = rest;
  if (!id || extra.length || flags.has('--member')) {
    write(COMPUTERS_USAGE);
    return 2;
  }
  if (!UUID.test(id)) {
    write(`computers: no retired computer ${id}`);
    return 1;
  }
  const logger = ctx.logger ?? createLogger('error');
  const machines = computerProvider({ config, logger });
  if (!machines?.retire) {
    write('computers: this install keeps no retired computers to restore');
    return 1;
  }
  try {
    const { restored, replaced } = await inWorkspace(org, () =>
      restoreRetiredComputer(
        { db, logger, infra: ctx.infra },
        machines,
        { workspaceId: org, retiredId: id },
        SYSTEM_ACTOR,
      ),
    );
    write(
      `Restored ${restored.id}: it is the member's computer again, and starts at its next use.`,
    );
    if (replaced) {
      write(
        `The computer they had is retired in turn as ${replaced.id}, kept until ${replaced.deleteAfter.toISOString()}.`,
      );
    }
    return 0;
  } catch (error) {
    if (error instanceof DomainError && (error.status === 404 || error.status === 409)) {
      write(`computers: ${error.message}`);
      return 1;
    }
    throw error;
  }
}
