import { hkdfSync, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import type { ArtifactSharing, ShareRequest } from '@openbots/agent';
import {
  REQUEST_ARTIFACT_SHARE_TOOL,
  type ArtifactKind,
  type ArtifactVisibility,
} from '@openbots/shared';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { hostLabel, type HostView, type Viewer } from '../artifact-host/handler.js';
import { newNonce, signClaims, VIEW_TOKEN_SECONDS } from '../artifact-host/tokens.js';
import type { Config } from '../config.js';
import type { AppDeps, CurrentUser } from '../context.js';
import { schema, type Db } from '../db/client.js';
import { artifactHostWorkspace, inWorkspace } from '../db/scope.js';
import { DomainError, notFound } from '../errors.js';
import { parseMasterKey } from '../secrets.js';
import { effectiveSettings, getOrganization, type Workspace } from '../workspace.js';
import { recordAudit, type AuditActor } from './audit.js';
import { isDeviceKey } from './devices.js';
import { openFile } from './files.js';

// Sharing Artifacts and the artifact host's rules (plan 21.11).
//
// An Artifact is private to its owner. Its owner may share it with the
// organization (every active member views it read only, at its latest
// version) or make it public (anyone with the link views the version the
// owner confirmed; later versions stay private until they confirm again).
// Only a person widens it: the owner in the app or on a paired device
// (`assertPerson`), or the owner approving a Bot's `request_artifact_share`,
// which the policy engine never runs unasked and which `shareFromApproval`
// checks against the approval row itself. Every change is audited.
//
// Who sees what, asked on every request (`viewOf`): the owner sees the
// latest version; an active member sees an organization Artifact's latest
// version; anyone sees a public Artifact's confirmed version while the
// organization allows public sharing and no operator took it down. When the
// owner is suspended or removed, nothing of theirs is served to anyone until
// they are back: a person who can no longer act in the organization cannot
// stand behind what it shows.
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

/** The Artifact's address on the artifact host, or null when its Bot is gone or the label cannot fit. */
export function artifactHostUrl(
  config: Pick<Config, 'artifactHost' | 'publicUrl'>,
  botSlug: string | null,
  orgSlug: string,
  artifactId: string,
): string | null {
  if (!config.artifactHost || !botSlug) return null;
  const label = hostLabel(botSlug, orgSlug);
  if (!label) return null;
  // The app's scheme: https in production; http only on a development install.
  const scheme = new URL(config.publicUrl).protocol === 'http:' ? 'http' : 'https';
  return `${scheme}://${label}.${config.artifactHost.domain}/${artifactId}/`;
}

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
    artifact.publicVersionId !== null &&
    effectiveSettings(config, workspace).publicArtifactsEnabled
  );
}

/**
 * The version `viewerId` (or nobody) may see of `artifact`, and why; null
 * when they may see none. Must run in the Artifact's organization's scope.
 */
export async function viewOf(
  deps: Pick<AppDeps, 'db' | 'config'>,
  artifact: ArtifactRow,
  viewerId: string | null,
): Promise<{ audience: Audience; version: VersionRow } | null> {
  const { db } = deps;
  if (!(await isActiveMember(db, artifact.workspaceId, artifact.ownerId))) return null;
  if (viewerId === artifact.ownerId) {
    const version = await versionById(db, artifact.currentVersionId);
    return version && { audience: 'owner', version };
  }
  if (
    viewerId &&
    artifact.visibility === 'org' &&
    (await isActiveMember(db, artifact.workspaceId, viewerId))
  ) {
    const version = await versionById(db, artifact.currentVersionId);
    return version && { audience: 'member', version };
  }
  const workspace = await getOrganization(db, artifact.workspaceId);
  if (publiclyServed(deps.config, workspace, artifact)) {
    const version = await versionById(db, artifact.publicVersionId);
    return version && { audience: 'public', version };
  }
  return null;
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
  version: number | null;
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
    version: typeof args.version === 'number' ? args.version : null,
    createdAt: row.approval.createdAt,
  };
}

export interface SharingState {
  visibility: ArtifactVisibility;
  currentVersion: number | null;
  /** The version anyone with the link sees, while public. */
  publicVersion: number | null;
  /** The organization lets members make Artifacts public. */
  publicAllowed: boolean;
  /** An operator took the public link down. */
  takenDown: boolean;
  /** The address on the artifact host, without any token; null when it has none. */
  url: string | null;
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

async function sharingState(
  deps: SharingDeps,
  owner: Member,
  artifact: ArtifactRow,
): Promise<SharingState> {
  const { db, config } = deps;
  const { workspace, botSlug } = await hostNames(db, artifact);
  const current = await versionById(db, artifact.currentVersionId);
  const pinned = await versionById(db, artifact.publicVersionId);
  return {
    visibility: artifact.visibility,
    currentVersion: current?.version ?? null,
    publicVersion: artifact.visibility === 'public' ? (pinned?.version ?? null) : null,
    publicAllowed: effectiveSettings(config, workspace).publicArtifactsEnabled,
    takenDown: artifact.takenDownAt !== null,
    url: artifactHostUrl(config, botSlug, workspace.slug, artifact.id),
    sharedAt: artifact.sharedAt,
    pendingRequest: await pendingRequest(db, owner, artifact.id),
  };
}

export const publicSharingOff = () =>
  new DomainError(
    403,
    'PUBLIC_SHARING_OFF',
    'Your organization has turned off public links. An owner or admin can turn them on in Settings.',
  );

export const takenDown = () =>
  new DomainError(
    409,
    'TAKEN_DOWN',
    'The public link to this Artifact was taken down by the service. It cannot be made public again.',
  );

export interface VisibilityChange {
  visibility: ArtifactVisibility;
  /** For `public`: the version to publish, by number. */
  version?: number | undefined;
}

/**
 * Changes who may see an Artifact, as `actor` (always a person: the owner,
 * or the owner approving their Bot's request). `public` publishes the named
 * version; with `requireCurrent` it must still be the current one, so a
 * person never confirms a version they did not see. Locked against
 * concurrent writers; audited.
 */
export async function setVisibility(
  deps: SharingDeps,
  owner: Member,
  artifactId: string,
  change: VisibilityChange,
  actor: AuditActor & { type: 'user' },
  options: { requireCurrent?: boolean; approvalId?: string } = {},
): Promise<SharingState> {
  requireArtifactHost(deps.config);
  const artifact = await deps.db.transaction(async (tx) => {
    const row = await ownedArtifact(tx, owner, artifactId, true);
    let publicVersion: VersionRow | null = null;
    if (change.visibility === 'public') {
      const workspace = await getOrganization(tx, row.workspaceId);
      if (!effectiveSettings(deps.config, workspace).publicArtifactsEnabled) {
        throw publicSharingOff();
      }
      if (row.takenDownAt) throw takenDown();
      if (change.version === undefined) {
        throw new DomainError(400, 'VERSION_REQUIRED', 'Name the version to make public');
      }
      const [version] = await tx
        .select()
        .from(schema.artifactVersions)
        .where(
          and(
            eq(schema.artifactVersions.artifactId, row.id),
            eq(schema.artifactVersions.version, change.version),
          ),
        );
      if (!version) throw notFound('Version not found');
      if (options.requireCurrent && version.id !== row.currentVersionId) {
        const current = await versionById(tx, row.currentVersionId);
        throw new DomainError(
          409,
          'VERSION_CONFLICT',
          `A newer version (v${current?.version ?? '?'}) was saved. Check it, then make it public.`,
        );
      }
      publicVersion = version;
    }
    const before = await versionById(tx, row.publicVersionId);
    const [updated] = await tx
      .update(schema.artifacts)
      .set({
        visibility: change.visibility,
        // Going back to org or private forgets the confirmed version: public
        // again later needs a person to confirm one again.
        publicVersionId: publicVersion?.id ?? null,
        sharedBy: actor.id,
        sharedAt: new Date(),
      })
      .where(eq(schema.artifacts.id, row.id))
      .returning();
    await recordAudit(tx, {
      workspaceId: row.workspaceId,
      actor,
      action: 'artifact.visibility',
      targetType: 'artifact',
      targetId: row.id,
      metadata: {
        from: row.visibility,
        to: change.visibility,
        ...(before && row.visibility === 'public' ? { fromVersion: before.version } : {}),
        ...(publicVersion ? { version: publicVersion.version } : {}),
        ...(options.approvalId ? { approvalId: options.approvalId } : {}),
      },
    });
    return updated!;
  });
  return sharingState(deps, owner, artifact);
}

// --- A Bot's request, after its owner approved it -----------------------------------

const toShare = (args: unknown): ShareRequest | null => {
  const a = args as Partial<ShareRequest> | null;
  if (!a || typeof a.id !== 'string' || (a.visibility !== 'org' && a.visibility !== 'public')) {
    return null;
  }
  return {
    id: a.id,
    visibility: a.visibility,
    version: typeof a.version === 'number' ? a.version : undefined,
  };
};

const notApproved = () =>
  new Error(
    'Your owner has not approved sharing this Artifact. They decide in the app; nothing was shared.',
  );

/**
 * Applies a Bot's share request, only on the approval its owner gave for
 * this exact request in this run, decided by the Artifact's owner and not
 * used before. The policy engine already makes the call wait for that
 * approval; this is the server's own check, so a path that ran the tool any
 * other way still shares nothing.
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
      ),
    )
    .orderBy(desc(schema.approvals.decidedAt));
  const approval = rows.find((row) => {
    const asked = toShare(row.args);
    return (
      asked !== null &&
      asked.id === request.id &&
      asked.visibility === request.visibility &&
      asked.version === request.version &&
      row.decidedBy === owner.id
    );
  });
  if (!approval) throw notApproved();
  const [used] = await deps.db
    .select({ id: schema.auditLog.id })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.workspaceId, owner.workspaceId),
        eq(schema.auditLog.action, 'artifact.visibility'),
        sql`${schema.auditLog.metadata}->>'approvalId' = ${approval.id}`,
      ),
    );
  if (used) throw notApproved();
  return setVisibility(
    deps,
    owner,
    request.id,
    { visibility: request.visibility, version: request.version },
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
    async describe({ id, visibility, version }) {
      const artifact = await ownedArtifact(deps.db, owner, id).catch(() => null);
      if (!artifact) return `Share Artifact ${id}, which you do not have`;
      const title = `“${artifact.title.slice(0, 120)}”`;
      if (visibility === 'org') {
        return `Share ${title} with everyone in your organization: members can view its latest version, read only`;
      }
      return `Make version ${version ?? '?'} of ${title} public: anyone with the link can view it, without signing in`;
    },
    async apply(request) {
      const state = await shareFromApproval(deps, run, owner, request);
      return {
        shared: true,
        artifact_id: request.id,
        visibility: request.visibility,
        ...(state.publicVersion ? { version: state.publicVersion } : {}),
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

/**
 * Artifacts of the caller's organization that are shared beyond their owner
 * and that the caller may see now, most recently updated first: each with
 * only what a member needs to find and open it.
 */
export async function listShared(deps: SharingDeps, viewer: Member): Promise<SharedArtifact[]> {
  requireArtifactHost(deps.config);
  const rows = await deps.db
    .select()
    .from(schema.artifacts)
    .where(
      and(
        eq(schema.artifacts.workspaceId, viewer.workspaceId),
        inArray(schema.artifacts.visibility, ['org', 'public']),
      ),
    )
    .orderBy(desc(schema.artifacts.updatedAt));
  const out: SharedArtifact[] = [];
  for (const artifact of rows) {
    const view = await viewOf(deps, artifact, viewer.id);
    if (view) out.push(await describeShared(deps, artifact, view.audience, view.version));
  }
  return out;
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
  const url = artifactHostUrl(deps.config, botSlug, workspace.slug, artifact.id);
  if (!url) {
    throw new DomainError(
      409,
      'NO_LINK',
      'This Artifact has no link: the Bot that made it was deleted.',
    );
  }
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
