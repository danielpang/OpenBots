import { hkdfSync, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import type { ArtifactSharing, ShareRequest } from '@openbots/agent';
import {
  REQUEST_ARTIFACT_SHARE_TOOL,
  type ArtifactKind,
  type ArtifactVisibility,
} from '@openbots/shared';
import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { hostLabel, type HostView, type Viewer } from '../artifact-host/handler.js';
import { newNonce, signClaims, VIEW_TOKEN_SECONDS } from '../artifact-host/tokens.js';
import type { Config } from '../config.js';
import type { AppDeps, CurrentUser } from '../context.js';
import { schema, type Db } from '../db/client.js';
import { artifactHostWorkspace, inWorkspace } from '../db/scope.js';
import { DomainError, notFound } from '../errors.js';
import { parseMasterKey } from '../secrets.js';
import { effectiveSettings, getOrganization, isOrgAdmin, type Workspace } from '../workspace.js';
import { recordAudit, type AuditActor } from './audit.js';
import { isDeviceKey } from './devices.js';
import { openFile } from './files.js';

// Sharing Artifacts and the artifact host's rules (plan 21.11).
//
// An Artifact is private to its owner. Its owner may share it with the
// organization (every active member views it read only) or, once an owner
// or admin turned public links on for the organization, make it public
// (anyone with the link views it). Either way viewers always see the latest
// version: what a Bot saves later is shown without anyone confirming it.
// Only a person widens it: the owner in the app or on a paired device
// (`assertPerson`), or the owner approving a Bot's `request_artifact_share`,
// which the policy engine never runs unasked and which `shareFromApproval`
// checks against the approval row itself. An owner or admin of the
// organization may narrow anyone's shared Artifact, never widen it. Every
// change is audited.
//
// Who sees what, asked on every request (`viewOf`): the owner sees it while
// they are an active member; an active member sees an organization Artifact;
// anyone sees a public Artifact while the organization allows public links
// and no operator took it down. When the owner is suspended or removed, what
// they shared stays shared (an owner or admin can stop it), and their
// private Artifacts are served to nobody.
//
// All of it is off unless OPENBOTS_ARTIFACT_DOMAIN is set: the routes answer
// 404 and the Bot is not offered the tool.

type Member = Pick<CurrentUser, 'id' | 'workspaceId'>;
type SharingDeps = Pick<AppDeps, 'db' | 'config' | 'extensions'>;

export type ArtifactRow = typeof schema.artifacts.$inferSelect;
type VersionRow = typeof schema.artifactVersions.$inferSelect;

export const sharingOff = () => notFound('Not found');

/** The host settings, or 404 when this install does not host Artifacts. */
export function requireArtifactHost(config: Pick<Config, 'artifactHost'>) {
  if (!config.artifactHost) throw sharingOff();
  return config.artifactHost;
}

export const personRequired = () =>
  new DomainError(
    403,
    'PERSON_REQUIRED',
    'Only a person can share an Artifact: use the app or a paired device. An API key cannot.',
  );

/**
 * A person is behind the request: a signed-in session, or a device the
 * owner paired (the phone, the Mac app). A plain API key is a script's, and
 * so is anything a Bot could hold, so it may narrow what is shared but never
 * widen it.
 */
export async function assertPerson(
  db: Db,
  caller: Pick<CurrentUser, 'workspaceId'> & { apiKeyId?: string | null },
): Promise<void> {
  if (!caller.apiKeyId) return;
  if (await isDeviceKey(db, { workspaceId: caller.workspaceId, apiKeyId: caller.apiKeyId })) return;
  throw personRequired();
}

// --- Names on the artifact domain ------------------------------------------------

/**
 * A new Bot's public slug: its handle's letters and digits, then eight
 * random hex digits, short enough that `<slug>--<organization slug>` fits a
 * DNS label. Never `--` inside, never empty, at least three characters.
 */
export function botPublicSlug(
  handle: string,
  orgSlug: string,
  suffix = randomBytes(4).toString('hex'),
): string {
  const budget = Math.min(31, 61 - orgSlug.length);
  // The same rule as the backfill in drizzle/0048, for Bots made before it.
  const letters =
    handle
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'bot';
  const part = letters.slice(0, Math.max(0, budget - suffix.length - 1)).replace(/-+$/, '');
  return part ? `${part}-${suffix}` : suffix;
}

/** Why an Artifact has no address on the artifact host. */
export type NoLinkReason = 'bot_deleted' | 'address_too_long';

/**
 * The Artifact's address on the artifact host, or why it has none: its Bot
 * is gone, or `<bot slug>--<organization slug>` cannot fit a DNS label (an
 * organization migration 0021 named after its whole name).
 */
export function artifactHostLink(
  config: Pick<Config, 'artifactHost' | 'publicUrl'>,
  botSlug: string | null,
  orgSlug: string,
  artifactId: string,
): { url: string; noLink: null } | { url: null; noLink: NoLinkReason | null } {
  if (!config.artifactHost) return { url: null, noLink: null };
  if (!botSlug) return { url: null, noLink: 'bot_deleted' };
  const label = hostLabel(botSlug, orgSlug);
  if (!label) return { url: null, noLink: 'address_too_long' };
  // The app's scheme: https in production; http only on a development install.
  const scheme = new URL(config.publicUrl).protocol === 'http:' ? 'http' : 'https';
  return { url: `${scheme}://${label}.${config.artifactHost.domain}/${artifactId}/`, noLink: null };
}

/** The Artifact's address on the artifact host, or null when it has none (`artifactHostLink`). */
export function artifactHostUrl(
  config: Pick<Config, 'artifactHost' | 'publicUrl'>,
  botSlug: string | null,
  orgSlug: string,
  artifactId: string,
): string | null {
  return artifactHostLink(config, botSlug, orgSlug, artifactId).url;
}

const noLinkError = (reason: NoLinkReason) =>
  reason === 'address_too_long'
    ? new DomainError(
        409,
        'ADDRESS_TOO_LONG',
        "This organization's address is too long for a link, so its Artifacts cannot be opened in the browser. You can still download them.",
      )
    : new DomainError(
        409,
        'NO_LINK',
        'This Artifact has no link: the Bot that made it was deleted.',
      );

/** The host's keys, each derived from the master key for its one purpose. */
export function artifactHostKeys(masterKey: string): { token: Uint8Array; cookie: Uint8Array } {
  const key = parseMasterKey(masterKey);
  return {
    token: new Uint8Array(hkdfSync('sha256', key, '', 'openbots:artifact-host-token', 32)),
    cookie: new Uint8Array(hkdfSync('sha256', key, '', 'openbots:artifact-host-cookie', 32)),
  };
}

// --- Who sees what ---------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function isActiveMember(db: Db, workspaceId: string, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: schema.workspaceMembers.id })
    .from(schema.workspaceMembers)
    .where(
      and(
        eq(schema.workspaceMembers.workspaceId, workspaceId),
        eq(schema.workspaceMembers.userId, userId),
        isNull(schema.workspaceMembers.suspendedAt),
      ),
    );
  return row !== undefined;
}

async function versionById(db: Db, id: string | null): Promise<VersionRow | null> {
  if (!id) return null;
  const [row] = await db
    .select()
    .from(schema.artifactVersions)
    .where(eq(schema.artifactVersions.id, id));
  return row ?? null;
}

export type Audience = 'owner' | 'member' | 'public';

/** Whether the organization's public links are served at all, for this Artifact. */
function publiclyServed(config: Config, workspace: Workspace, artifact: ArtifactRow): boolean {
  return (
    artifact.visibility === 'public' &&
    artifact.takenDownAt === null &&
    effectiveSettings(config, workspace).publicArtifactsEnabled
  );
}

/**
 * Who `viewerId` (or nobody) sees `artifact` as, with its latest version;
 * null when they may not see it. Must run in the Artifact's organization's
 * scope. The owner counts as the owner only while an active member: a
 * suspended or removed owner's private Artifacts are served to nobody, and
 * what they shared is served as it is to everyone else.
 */
export async function viewOf(
  deps: Pick<AppDeps, 'db' | 'config'>,
  artifact: ArtifactRow,
  viewerId: string | null,
): Promise<{ audience: Audience; version: VersionRow } | null> {
  const audience = await audienceOf(deps, artifact, viewerId);
  if (!audience) return null;
  const version = await versionById(deps.db, artifact.currentVersionId);
  return version && { audience, version };
}

async function audienceOf(
  deps: Pick<AppDeps, 'db' | 'config'>,
  artifact: ArtifactRow,
  viewerId: string | null,
): Promise<Audience | null> {
  const { db } = deps;
  if (
    viewerId &&
    viewerId === artifact.ownerId &&
    (await isActiveMember(db, artifact.workspaceId, viewerId))
  ) {
    return 'owner';
  }
  if (
    viewerId &&
    artifact.visibility === 'org' &&
    (await isActiveMember(db, artifact.workspaceId, viewerId))
  ) {
    return 'member';
  }
  const workspace = await getOrganization(db, artifact.workspaceId);
  return publiclyServed(deps.config, workspace, artifact) ? 'public' : null;
}

// --- The owner's view and changes -------------------------------------------------

async function ownedArtifact(db: Db, owner: Member, artifactId: string, lock = false) {
  if (!UUID.test(artifactId)) throw notFound('Artifact not found');
  const query = db
    .select()
    .from(schema.artifacts)
    .where(
      and(
        eq(schema.artifacts.id, artifactId),
        eq(schema.artifacts.ownerId, owner.id),
        eq(schema.artifacts.workspaceId, owner.workspaceId),
      ),
    );
  const [row] = lock ? await query.for('update') : await query;
  if (!row) throw notFound('Artifact not found');
  return row;
}

async function hostNames(db: Db, artifact: ArtifactRow) {
  const workspace = await getOrganization(db, artifact.workspaceId);
  const [bot] = artifact.botId
    ? await db
        .select({ publicSlug: schema.bots.publicSlug, name: schema.bots.name })
        .from(schema.bots)
        .where(
          and(
            eq(schema.bots.id, artifact.botId),
            eq(schema.bots.workspaceId, artifact.workspaceId),
          ),
        )
    : [];
  return { workspace, botSlug: bot?.publicSlug ?? null, botName: bot?.name ?? null };
}

export interface PendingShareRequest {
  approvalId: string;
  visibility: 'org' | 'public';
  createdAt: Date;
}

/** A Bot's request to share this Artifact that its owner has not answered yet. */
async function pendingRequest(
  db: Db,
  owner: Member,
  artifactId: string,
): Promise<PendingShareRequest | null> {
  const [row] = await db
    .select({ approval: schema.approvals })
    .from(schema.approvals)
    .innerJoin(schema.runs, eq(schema.runs.id, schema.approvals.runId))
    .innerJoin(schema.bots, eq(schema.bots.id, schema.runs.botId))
    .where(
      and(
        eq(schema.approvals.status, 'pending'),
        eq(schema.approvals.toolName, REQUEST_ARTIFACT_SHARE_TOOL),
        sql`${schema.approvals.args}->>'id' = ${artifactId}`,
        eq(schema.bots.ownerId, owner.id),
        eq(schema.bots.workspaceId, owner.workspaceId),
      ),
    )
    .orderBy(desc(schema.approvals.createdAt))
    .limit(1);
  if (!row) return null;
  const args = row.approval.args as Partial<ShareRequest>;
  return {
    approvalId: row.approval.id,
    visibility: args.visibility === 'public' ? 'public' : 'org',
    createdAt: row.approval.createdAt,
  };
}

export interface SharingState {
  visibility: ArtifactVisibility;
  currentVersion: number | null;
  /** The organization lets members make Artifacts public. */
  publicAllowed: boolean;
  /** An operator took the public link down. */
  takenDown: boolean;
  /** The address on the artifact host, without any token; null when it has none. */
  url: string | null;
  /** Why `url` is null. */
  noLink: NoLinkReason | null;
  sharedAt: Date | null;
  pendingRequest: PendingShareRequest | null;
}

export async function getSharing(
  deps: SharingDeps,
  owner: Member,
  artifactId: string,
): Promise<SharingState> {
  requireArtifactHost(deps.config);
  const artifact = await ownedArtifact(deps.db, owner, artifactId);
  return sharingState(deps, owner, artifact);
}

/** The sharing of `artifact` as its owner sees it; with `owner` null (an admin), no pending request. */
async function sharingState(
  deps: SharingDeps,
  owner: Member | null,
  artifact: ArtifactRow,
): Promise<SharingState> {
  const { db, config } = deps;
  const { workspace, botSlug } = await hostNames(db, artifact);
  const current = await versionById(db, artifact.currentVersionId);
  return {
    visibility: artifact.visibility,
    currentVersion: current?.version ?? null,
    publicAllowed: effectiveSettings(config, workspace).publicArtifactsEnabled,
    takenDown: artifact.takenDownAt !== null,
    ...artifactHostLink(config, botSlug, workspace.slug, artifact.id),
    sharedAt: artifact.sharedAt,
    pendingRequest: owner ? await pendingRequest(db, owner, artifact.id) : null,
  };
}

export const publicSharingOff = () =>
  new DomainError(
    403,
    'PUBLIC_SHARING_OFF',
    'Your organization has not turned on public links. An owner or admin can turn them on in Settings.',
  );

export const ownerOnly = () =>
  new DomainError(
    403,
    'OWNER_ONLY',
    'Only its owner can share this Artifact more widely. You can stop sharing it, or share it less widely.',
  );

/**
 * Serializes making an Artifact public with turning public links off in its
 * organization: a share takes this lock shared before it locks the Artifact,
 * the switch takes it alone (`stopPublicLinks`), so no Artifact is made
 * public on a setting read just before it went off.
 */
const publicLinksLock = (db: Db, workspaceId: string, mode: 'share' | 'alone') =>
  db.execute(
    mode === 'share'
      ? sql`select pg_advisory_xact_lock_shared(hashtext(${`artifact-public:${workspaceId}`}))`
      : sql`select pg_advisory_xact_lock(hashtext(${`artifact-public:${workspaceId}`}))`,
  );

/**
 * Turning public links off (`PATCH /settings`): every public Artifact of the
 * organization becomes an organization one, in the caller's transaction, so
 * turning them on again brings no old link back; each owner makes theirs
 * public again. Audited per Artifact as `artifact.visibility`. Returns how
 * many it changed.
 */
export async function stopPublicLinks(
  tx: Db,
  workspaceId: string,
  actor: AuditActor,
): Promise<number> {
  await publicLinksLock(tx, workspaceId, 'alone');
  const changed = await tx
    .update(schema.artifacts)
    .set({ visibility: 'org', sharedBy: actor.id, sharedAt: new Date() })
    .where(
      and(eq(schema.artifacts.workspaceId, workspaceId), eq(schema.artifacts.visibility, 'public')),
    )
    .returning({ id: schema.artifacts.id });
  if (changed.length) {
    await tx.insert(schema.auditLog).values(
      changed.map((row) => ({
        workspaceId,
        actorType: actor.type,
        actorId: actor.id,
        action: 'artifact.visibility',
        targetType: 'artifact',
        targetId: row.id,
        metadata: { from: 'public', to: 'org', reason: 'public_links_off' },
      })),
    );
  }
  return changed.length;
}

/** How many of the organization's Artifacts are public now: the links turning them off stops. */
export async function countPublic(db: Db, workspaceId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.artifacts)
    .where(
      and(eq(schema.artifacts.workspaceId, workspaceId), eq(schema.artifacts.visibility, 'public')),
    );
  return Number(row?.n ?? 0);
}

export const takenDown = () =>
  new DomainError(
    409,
    'TAKEN_DOWN',
    'The public link to this Artifact was taken down by the service. It cannot be made public again.',
  );

export interface VisibilityChange {
  visibility: ArtifactVisibility;
}

const RANK: Record<ArtifactVisibility, number> = { private: 0, org: 1, public: 2 };

/** Whether `next` shows the Artifact to anyone `current` does not: only a person may do that. */
export const widens = (current: ArtifactVisibility, next: ArtifactVisibility) =>
  next === 'public' || RANK[next] > RANK[current];

/**
 * Changes who may see an Artifact, as `actor` (always a person: the owner,
 * or the owner approving their Bot's request). With `caller`, a change that
 * widens it needs a person behind the request (`assertPerson`), judged
 * against the row as locked, so a script's narrowing never lands as a
 * widening of what the owner changed meanwhile. With `approvalId`, the
 * approval is used up here, once, and only for this Artifact. `public`
 * needs the organization's public links on, read under `publicLinksLock`.
 * Locked against concurrent writers; audited.
 */
export async function setVisibility(
  deps: SharingDeps,
  owner: Member,
  artifactId: string,
  change: VisibilityChange,
  actor: AuditActor & { type: 'user' },
  options: {
    approvalId?: string;
    caller?: Parameters<typeof assertPerson>[1];
  } = {},
): Promise<SharingState> {
  requireArtifactHost(deps.config);
  const artifact = await deps.db.transaction(async (tx) => {
    // Before the Artifact's lock, so it is always taken in the same order.
    if (change.visibility === 'public') await publicLinksLock(tx, owner.workspaceId, 'share');
    const row = await ownedArtifact(tx, owner, artifactId, true);
    if (options.caller && widens(row.visibility, change.visibility)) {
      await assertPerson(tx, options.caller);
    }
    // An approval shares once: the approval row records its use, under the
    // Artifact's lock and in this transaction, so two runs of the same
    // approved call cannot both pass, and a failed share leaves it unused.
    if (options.approvalId) {
      const [claimed] = await tx
        .update(schema.approvals)
        .set({ consumedAt: new Date() })
        .where(
          and(
            eq(schema.approvals.id, options.approvalId),
            eq(schema.approvals.workspaceId, row.workspaceId),
            eq(schema.approvals.status, 'approved'),
            isNull(schema.approvals.consumedAt),
            sql`${schema.approvals.args}->>'id' = ${row.id}`,
          ),
        )
        .returning({ id: schema.approvals.id });
      if (!claimed) throw notApproved();
    }
    if (change.visibility === 'public') {
      const workspace = await getOrganization(tx, row.workspaceId);
      if (!effectiveSettings(deps.config, workspace).publicArtifactsEnabled) {
        throw publicSharingOff();
      }
      if (row.takenDownAt) throw takenDown();
    }
    return writeVisibility(tx, row, change.visibility, actor, {
      ...(options.approvalId ? { approvalId: options.approvalId } : {}),
    });
  });
  return sharingState(deps, owner, artifact);
}

async function writeVisibility(
  tx: Db,
  row: ArtifactRow,
  visibility: ArtifactVisibility,
  actor: AuditActor & { type: 'user' },
  metadata: Record<string, unknown>,
): Promise<ArtifactRow> {
  const [updated] = await tx
    .update(schema.artifacts)
    .set({ visibility, sharedBy: actor.id, sharedAt: new Date() })
    .where(eq(schema.artifacts.id, row.id))
    .returning();
  await recordAudit(tx, {
    workspaceId: row.workspaceId,
    actor,
    action: 'artifact.visibility',
    targetType: 'artifact',
    targetId: row.id,
    metadata: { from: row.visibility, to: visibility, ...metadata },
  });
  return updated!;
}

/**
 * `PUT /artifacts/{id}/sharing`: its owner changes who may see it
 * (`setVisibility`), or an owner or admin of the organization narrows
 * someone else's shared Artifact, which is how what a suspended or removed
 * member shared is stopped. An admin never widens another's Artifact (403
 * `OWNER_ONLY`) and never reaches a private one (404, as for anyone else);
 * narrowing needs no person, as an owner's does not. Audited with the owner.
 */
export async function changeSharing(
  deps: SharingDeps,
  caller: CurrentUser & { apiKeyId?: string | null },
  artifactId: string,
  change: VisibilityChange,
): Promise<SharingState> {
  requireArtifactHost(deps.config);
  if (!UUID.test(artifactId)) throw notFound('Artifact not found');
  const [found] = await deps.db
    .select({ ownerId: schema.artifacts.ownerId })
    .from(schema.artifacts)
    .where(
      and(
        eq(schema.artifacts.id, artifactId),
        eq(schema.artifacts.workspaceId, caller.workspaceId),
      ),
    );
  if (!found || found.ownerId === caller.id || !isOrgAdmin(caller.role)) {
    return setVisibility(
      deps,
      caller,
      artifactId,
      change,
      { type: 'user', id: caller.id },
      {
        caller,
      },
    );
  }
  const artifact = await deps.db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(schema.artifacts)
      .where(
        and(
          eq(schema.artifacts.id, artifactId),
          eq(schema.artifacts.workspaceId, caller.workspaceId),
        ),
      )
      .for('update');
    // Only what is shared with the organization is within an admin's reach.
    if (!row || row.visibility === 'private') throw notFound('Artifact not found');
    if (RANK[change.visibility] >= RANK[row.visibility]) throw ownerOnly();
    return writeVisibility(
      tx,
      row,
      change.visibility,
      { type: 'user', id: caller.id },
      { owner: row.ownerId },
    );
  });
  return sharingState(deps, null, artifact);
}

// --- A Bot's request, after its owner approved it -----------------------------------

const toShare = (args: unknown): ShareRequest | null => {
  const a = args as Partial<ShareRequest> | null;
  if (!a || typeof a.id !== 'string' || (a.visibility !== 'org' && a.visibility !== 'public')) {
    return null;
  }
  return { id: a.id, visibility: a.visibility };
};

const notApproved = () =>
  new Error(
    'Your owner has not approved sharing this Artifact. They decide in the app; nothing was shared.',
  );

/**
 * Applies a Bot's share request, only on the approval its owner gave for
 * this exact request (this Artifact, this audience) in this run, decided by
 * the Artifact's owner and not used before. The policy engine already makes
 * the call wait for that approval; this is the server's own check, so a path
 * that ran the tool any other way still shares nothing. What is shared is
 * the Artifact itself: its viewers see its latest version, now and later.
 */
export async function shareFromApproval(
  deps: SharingDeps,
  run: { id: string },
  owner: Member,
  request: ShareRequest,
): Promise<SharingState> {
  requireArtifactHost(deps.config);
  const rows = await deps.db
    .select()
    .from(schema.approvals)
    .where(
      and(
        eq(schema.approvals.runId, run.id),
        eq(schema.approvals.toolName, REQUEST_ARTIFACT_SHARE_TOOL),
        eq(schema.approvals.status, 'approved'),
        eq(schema.approvals.workspaceId, owner.workspaceId),
        isNull(schema.approvals.consumedAt),
      ),
    )
    .orderBy(desc(schema.approvals.decidedAt));
  const approval = rows.find((row) => {
    const asked = toShare(row.args);
    return (
      asked !== null &&
      asked.id === request.id &&
      asked.visibility === request.visibility &&
      row.decidedBy === owner.id
    );
  });
  if (!approval) throw notApproved();
  return setVisibility(
    deps,
    owner,
    request.id,
    { visibility: request.visibility },
    { type: 'user', id: approval.decidedBy! },
    { approvalId: approval.id },
  );
}

/** The `share` backend of a run's artifact tools; undefined when the install does not host Artifacts. */
export function artifactSharing(
  deps: SharingDeps,
  run: { id: string },
  owner: Member,
): ArtifactSharing | undefined {
  if (!deps.config.artifactHost) return undefined;
  return {
    async prepare({ id, visibility }) {
      const artifact = await ownedArtifact(deps.db, owner, id).catch(() => null);
      if (!artifact) return { summary: `Share Artifact ${id}, which you do not have` };
      const title = `“${artifact.title.slice(0, 120)}”`;
      if (visibility === 'org') {
        return {
          summary: `Share ${title} with everyone in your organization: members can view it and every future version of it, read only`,
        };
      }
      // Refused now, with nobody asked: the owner could not approve it anyway.
      const workspace = await getOrganization(deps.db, artifact.workspaceId);
      if (!effectiveSettings(deps.config, workspace).publicArtifactsEnabled) {
        throw new Error(
          `${title} cannot be made public: your organization has not turned on public links. An owner or admin can turn them on in Settings. You can ask to share it with the organization instead.`,
        );
      }
      if (artifact.takenDownAt) {
        throw new Error(`${title} cannot be made public: the service took its public link down.`);
      }
      return {
        summary: `Make ${title} public: anyone with the link can view it and every future version of it, without signing in`,
      };
    },
    async apply(request) {
      const state = await shareFromApproval(deps, run, owner, request);
      return {
        shared: true,
        artifact_id: request.id,
        visibility: request.visibility,
        ...(state.url ? { url: state.url } : {}),
      };
    },
  };
}

// --- Members' read-only access -------------------------------------------------------

export interface SharedArtifact {
  artifact: ArtifactRow;
  audience: Audience;
  version: VersionRow;
  ownerName: string;
  botName: string | null;
  url: string | null;
}

async function describeShared(
  deps: SharingDeps,
  artifact: ArtifactRow,
  audience: Audience,
  version: VersionRow,
): Promise<SharedArtifact> {
  const { workspace, botSlug, botName } = await hostNames(deps.db, artifact);
  const [owner] = await deps.db
    .select({ name: schema.users.name })
    .from(schema.users)
    .where(eq(schema.users.id, artifact.ownerId));
  return {
    artifact,
    audience,
    version,
    ownerName: owner?.name ?? '',
    botName,
    url: artifactHostUrl(deps.config, botSlug, workspace.slug, artifact.id),
  };
}

/** How many shared Artifacts a page lists by default, and at most. */
export const SHARED_PAGE = { size: 50, max: 100 } as const;

export interface SharedPage {
  items: SharedArtifact[];
  /** The last Artifact of this page, to pass as `cursor` for the next; null on the last page. */
  nextCursor: string | null;
}

/**
 * Artifacts of the caller's organization that are shared beyond their owner
 * and that the caller may see now, most recently updated first, `limit` at
 * a time: each with only what a member needs to find and open it. Who sees
 * what is `viewOf`'s rule, asked in the query itself so a page is full, with
 * everything a row needs read for the whole page at once.
 */
export async function listShared(
  deps: SharingDeps,
  viewer: Member,
  { cursor, limit = SHARED_PAGE.size }: { cursor?: string; limit?: number } = {},
): Promise<SharedPage> {
  requireArtifactHost(deps.config);
  const { db, config } = deps;
  const a = schema.artifacts;
  const take = Math.min(Math.max(1, limit), SHARED_PAGE.max);
  const workspace = await getOrganization(db, viewer.workspaceId);
  const publicServed = effectiveSettings(config, workspace).publicArtifactsEnabled;
  const viewerActive = await isActiveMember(db, viewer.workspaceId, viewer.id);
  const rows = await db
    .select()
    .from(a)
    .where(
      and(
        eq(a.workspaceId, viewer.workspaceId),
        inArray(a.visibility, ['org', 'public']),
        // What a suspended or removed owner shared stays listed, as `viewOf` serves it.
        or(
          viewerActive ? eq(a.ownerId, viewer.id) : undefined,
          viewerActive ? eq(a.visibility, 'org') : undefined,
          publicServed ? and(eq(a.visibility, 'public'), isNull(a.takenDownAt)) : undefined,
        ),
        // Keyset on (updated_at, id), read from the cursor row (as the attachments list).
        cursor
          ? sql`(${a.updatedAt}, ${a.id}) < (select updated_at, id from artifacts where id = ${cursor} and workspace_id = ${viewer.workspaceId})`
          : undefined,
      ),
    )
    .orderBy(desc(a.updatedAt), desc(a.id))
    .limit(take + 1);
  const page = rows.slice(0, take);
  const nextCursor = rows.length > take ? page[page.length - 1]!.id : null;
  if (!page.length) return { items: [], nextCursor };

  const audienceOf = (artifact: ArtifactRow): Audience =>
    artifact.ownerId === viewer.id ? 'owner' : artifact.visibility === 'org' ? 'member' : 'public';
  // Everyone who may see it sees its latest version.
  const versionIdOf = (artifact: ArtifactRow) => artifact.currentVersionId;
  const ids = (values: (string | null)[]) => [
    ...new Set(values.filter((v): v is string => v !== null)),
  ];
  const versionIds = ids(page.map(versionIdOf));
  const botIds = ids(page.map((artifact) => artifact.botId));
  const ownerIds = ids(page.map((artifact) => artifact.ownerId));
  const [versions, bots, owners] = await Promise.all([
    versionIds.length
      ? db
          .select()
          .from(schema.artifactVersions)
          .where(
            and(
              eq(schema.artifactVersions.workspaceId, viewer.workspaceId),
              inArray(schema.artifactVersions.id, versionIds),
            ),
          )
      : [],
    botIds.length
      ? db
          .select({
            id: schema.bots.id,
            publicSlug: schema.bots.publicSlug,
            name: schema.bots.name,
          })
          .from(schema.bots)
          .where(
            and(eq(schema.bots.workspaceId, viewer.workspaceId), inArray(schema.bots.id, botIds)),
          )
      : [],
    db
      .select({ id: schema.users.id, name: schema.users.name })
      .from(schema.users)
      .where(inArray(schema.users.id, ownerIds)),
  ]);
  const versionOf = new Map(versions.map((v) => [v.id, v]));
  const botOf = new Map(bots.map((b) => [b.id, b]));
  const ownerOf = new Map(owners.map((o) => [o.id, o.name]));
  const items: SharedArtifact[] = [];
  for (const artifact of page) {
    const versionId = versionIdOf(artifact);
    const version = versionId ? versionOf.get(versionId) : undefined;
    if (!version) continue;
    const bot = artifact.botId ? botOf.get(artifact.botId) : undefined;
    items.push({
      artifact,
      audience: audienceOf(artifact),
      version,
      ownerName: ownerOf.get(artifact.ownerId) ?? '',
      botName: bot?.name ?? null,
      url: artifactHostUrl(config, bot?.publicSlug ?? null, workspace.slug, artifact.id),
    });
  }
  return { items, nextCursor };
}

/** One shared Artifact the caller may see; 404 otherwise, the same for every reason. */
export async function getShared(
  deps: SharingDeps,
  viewer: Member,
  artifactId: string,
): Promise<SharedArtifact> {
  requireArtifactHost(deps.config);
  if (!UUID.test(artifactId)) throw notFound('Artifact not found');
  const [artifact] = await deps.db
    .select()
    .from(schema.artifacts)
    .where(
      and(
        eq(schema.artifacts.id, artifactId),
        eq(schema.artifacts.workspaceId, viewer.workspaceId),
        inArray(schema.artifacts.visibility, ['org', 'public']),
      ),
    );
  if (!artifact) throw notFound('Artifact not found');
  const view = await viewOf(deps, artifact, viewer.id);
  if (!view) throw notFound('Artifact not found');
  return describeShared(deps, artifact, view.audience, view.version);
}

/** The bytes of the version a shared Artifact's viewer may see. */
export async function openShared(
  deps: SharingDeps,
  viewer: Member,
  artifactId: string,
): Promise<SharedArtifact & { stream: Readable }> {
  const shared = await getShared(deps, viewer, artifactId);
  const { stream } = await openFile(
    deps,
    { id: shared.artifact.ownerId, workspaceId: shared.artifact.workspaceId },
    shared.version.storageKey,
  );
  return { ...shared, stream };
}

/**
 * A link that opens the Artifact on the artifact host for the caller: with a
 * view token when they see it as its owner or a member (the host trades it
 * for a cookie on that Artifact alone), bare when it is public.
 */
export async function openLink(
  deps: SharingDeps,
  viewer: Member,
  artifactId: string,
  now = Date.now(),
): Promise<{ url: string; expiresAt: Date | null }> {
  requireArtifactHost(deps.config);
  if (!UUID.test(artifactId)) throw notFound('Artifact not found');
  const [artifact] = await deps.db
    .select()
    .from(schema.artifacts)
    .where(
      and(
        eq(schema.artifacts.id, artifactId),
        eq(schema.artifacts.workspaceId, viewer.workspaceId),
      ),
    );
  if (!artifact) throw notFound('Artifact not found');
  const view = await viewOf(deps, artifact, viewer.id);
  if (!view) throw notFound('Artifact not found');
  const { workspace, botSlug } = await hostNames(deps.db, artifact);
  const { url, noLink } = artifactHostLink(deps.config, botSlug, workspace.slug, artifact.id);
  if (!url) throw noLinkError(noLink ?? 'bot_deleted');
  if (view.audience === 'public') return { url, expiresAt: null };
  const expires = now + VIEW_TOKEN_SECONDS * 1000;
  const token = await signClaims(artifactHostKeys(deps.config.masterKey).token, {
    a: artifact.id,
    u: viewer.id,
    w: viewer.workspaceId,
    e: expires,
    n: newNonce(),
  });
  return { url: `${url}?token=${token}`, expiresAt: new Date(expires) };
}

// --- The artifact host's lookups -------------------------------------------------------

/**
 * What the artifact host may serve for one request (artifact-host/handler.ts
 * `resolve`): the organization comes from the Bot's public slug alone
 * (`openbots_artifact_host_workspace`, drizzle/0048), and everything else is
 * read in that organization's scope. The organization slug must match too,
 * and a viewer from a token or cookie counts only in the organization they
 * were signed into.
 */
export async function resolveHostView(
  deps: Pick<AppDeps, 'db' | 'config'>,
  target: { botSlug: string; orgSlug: string; artifactId: string },
  viewer: Viewer | null,
): Promise<HostView | null> {
  const workspaceId = await artifactHostWorkspace(deps.db, target.botSlug);
  if (!workspaceId) return null;
  return inWorkspace(workspaceId, async () => {
    const [row] = await deps.db
      .select({ artifact: schema.artifacts })
      .from(schema.artifacts)
      .innerJoin(schema.bots, eq(schema.bots.id, schema.artifacts.botId))
      .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.artifacts.workspaceId))
      .where(
        and(
          eq(schema.artifacts.id, target.artifactId),
          eq(schema.artifacts.workspaceId, workspaceId),
          eq(schema.bots.publicSlug, target.botSlug),
          eq(schema.workspaces.slug, target.orgSlug),
        ),
      );
    if (!row) return null;
    const viewerId = viewer && viewer.workspaceId === workspaceId ? viewer.userId : null;
    const view = await viewOf(deps, row.artifact, viewerId);
    if (!view) return null;
    const { stream } = await openFile(
      deps,
      { id: row.artifact.ownerId, workspaceId },
      view.version.storageKey,
    );
    return {
      audience: view.audience,
      artifactId: row.artifact.id,
      kind: row.artifact.kind as ArtifactKind,
      title: row.artifact.title,
      version: view.version.version,
      mime: view.version.mime,
      size: view.version.size,
      body: async () => Readable.toWeb(stream) as ReadableStream<Uint8Array>,
      discard: () => stream.destroy(),
    };
  });
}

// --- The operator's switch ---------------------------------------------------------------

/**
 * Takes an Artifact's public link down at once, or puts it back (`openbots
 * artifacts takedown|restore <url>`): the operator's answer to abuse such
 * as a phishing page. Taken down, it is not served publicly and cannot be
 * made public again; its owner and members still see it as before. Audited
 * in the Artifact's organization as the system.
 */
export async function setTakedown(
  deps: Pick<AppDeps, 'db'>,
  target: { botSlug: string; orgSlug: string; artifactId: string },
  down: boolean,
  reason: string | null,
): Promise<{ workspaceId: string; title: string } | null> {
  const workspaceId = await artifactHostWorkspace(deps.db, target.botSlug);
  if (!workspaceId || !UUID.test(target.artifactId)) return null;
  return inWorkspace(workspaceId, () =>
    deps.db.transaction(async (tx) => {
      const [row] = await tx
        .select({ artifact: schema.artifacts })
        .from(schema.artifacts)
        .innerJoin(schema.bots, eq(schema.bots.id, schema.artifacts.botId))
        .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.artifacts.workspaceId))
        .where(
          and(
            eq(schema.artifacts.id, target.artifactId),
            eq(schema.bots.publicSlug, target.botSlug),
            eq(schema.workspaces.slug, target.orgSlug),
          ),
        )
        .for('update', { of: schema.artifacts });
      if (!row) return null;
      await tx
        .update(schema.artifacts)
        .set({ takenDownAt: down ? new Date() : null })
        .where(eq(schema.artifacts.id, row.artifact.id));
      await recordAudit(tx, {
        workspaceId,
        actor: { type: 'system', id: null },
        action: down ? 'artifact.taken_down' : 'artifact.restored',
        targetType: 'artifact',
        targetId: row.artifact.id,
        metadata: { visibility: row.artifact.visibility, ...(reason ? { reason } : {}) },
      });
      return { workspaceId, title: row.artifact.title };
    }),
  );
}
