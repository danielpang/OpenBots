import { Readable } from 'node:stream';
import { createRoute, z } from '@hono/zod-openapi';
import { artifactFileName } from '@openbots/artifacts';
import { ARTIFACT_KINDS } from '@openbots/shared';
import { DomainError } from '../errors.js';
import { requireUser } from '../middleware/auth.js';
import { authenticated, authProblems, createRouter, problemResponse } from '../openapi.js';
import {
  assertPerson,
  getShared,
  getSharing,
  listShared,
  openLink,
  openShared,
  requireArtifactHost,
  setVisibility,
  type SharedArtifact,
  type SharingState,
} from '../services/artifact-sharing.js';
import { userActor } from '../services/audit.js';
import { ArtifactVisibilitySchema, INLINE_MIME } from './artifacts.js';

// Sharing Artifacts (plan 21.11; services/artifact-sharing.ts). Core routes,
// so the web and phone apps share them; every one answers 404 unless the
// install hosts Artifacts (OPENBOTS_ARTIFACT_DOMAIN, `artifactSharing` in
// /capabilities).
//
// - The owner reads and changes who may see an Artifact. Widening it needs a
//   person (a session or a paired device, 403 PERSON_REQUIRED for an API
//   key); `public` needs `confirmed` and the version the person saw, which
//   must still be the current one.
// - Members of the organization list and read what is shared with it, read
//   only: the title, kind, who shared it, the version they may see and its
//   bytes. Nothing else of the owner's (the chat, the Bot, other Artifacts,
//   earlier versions) comes with it.
// - `POST /artifacts/{id}/open` gives the caller a link to the artifact host,
//   with a one-minute view token when they see it as its owner or a member.

const params = z.object({ id: z.uuid() });

const ShareRequestSchema = z
  .object({
    approvalId: z.uuid().openapi({ description: 'Answer it with `POST /approvals/{id}/decide`' }),
    visibility: z.enum(['org', 'public']),
    version: z.number().int().positive().nullable(),
    createdAt: z.iso.datetime(),
  })
  .openapi('ArtifactShareRequest');

const ArtifactSharingSchema = z
  .object({
    visibility: ArtifactVisibilitySchema,
    currentVersion: z.number().int().positive().nullable(),
    publicVersion: z.number().int().positive().nullable().openapi({
      description:
        'While public: the version anyone with the link sees. Later versions stay private until the owner confirms again.',
    }),
    publicAllowed: z
      .boolean()
      .openapi({ description: 'The organization lets members make Artifacts public' }),
    takenDown: z.boolean().openapi({
      description: 'The service took the public link down; it cannot be made public again',
    }),
    url: z.url().nullable().openapi({
      description:
        "The Artifact's address on the artifact host; null when the Bot that made it was deleted",
    }),
    sharedAt: z.iso.datetime().nullable(),
    pendingRequest: ShareRequestSchema.nullable().openapi({
      description: "A Bot's request to share it that the owner has not answered",
    }),
  })
  .openapi('ArtifactSharing');

const SharingChangeSchema = z
  .strictObject({
    visibility: ArtifactVisibilitySchema,
    version: z.number().int().positive().optional().openapi({
      description: 'For `public`: the version the person confirmed; it must be the current one',
    }),
    confirmed: z.literal(true).optional().openapi({
      description:
        'For `public`: the person confirmed that anyone with the link will be able to view it',
    }),
  })
  .openapi('ArtifactSharingChange');

const SharedArtifactSchema = z
  .object({
    id: z.uuid(),
    kind: z.enum(ARTIFACT_KINDS),
    title: z.string(),
    visibility: ArtifactVisibilitySchema,
    version: z
      .object({
        version: z.number().int().positive(),
        mime: z.string(),
        size: z.number().int(),
        createdAt: z.iso.datetime(),
      })
      .openapi({ description: 'The version the caller may see' }),
    ownerName: z.string(),
    botName: z.string().nullable(),
    mine: z.boolean(),
    url: z.url().nullable(),
    updatedAt: z.iso.datetime(),
  })
  .openapi('SharedArtifact');

const OpenLinkSchema = z
  .object({
    url: z.url().openapi({
      description:
        'Opens the Artifact on the artifact host. For the owner and members it carries a view token for this one Artifact, used once.',
    }),
    expiresAt: z.iso.datetime().nullable(),
  })
  .openapi('ArtifactOpenLink');

const iso = (date: Date | null) => (date ? new Date(date).toISOString() : null);

function toSharing(state: SharingState): z.infer<typeof ArtifactSharingSchema> {
  return {
    visibility: state.visibility,
    currentVersion: state.currentVersion,
    publicVersion: state.publicVersion,
    publicAllowed: state.publicAllowed,
    takenDown: state.takenDown,
    url: state.url,
    sharedAt: iso(state.sharedAt),
    pendingRequest: state.pendingRequest
      ? {
          approvalId: state.pendingRequest.approvalId,
          visibility: state.pendingRequest.visibility,
          version: state.pendingRequest.version,
          createdAt: iso(state.pendingRequest.createdAt)!,
        }
      : null,
  };
}

function toShared(shared: SharedArtifact, viewerId: string): z.infer<typeof SharedArtifactSchema> {
  return {
    id: shared.artifact.id,
    kind: shared.artifact.kind,
    title: shared.artifact.title,
    visibility: shared.artifact.visibility,
    version: {
      version: shared.version.version,
      mime: shared.version.mime,
      size: shared.version.size,
      createdAt: iso(shared.version.createdAt)!,
    },
    ownerName: shared.ownerName,
    botName: shared.botName,
    mine: shared.artifact.ownerId === viewerId,
    url: shared.url,
    updatedAt: iso(shared.artifact.updatedAt)!,
  };
}

const sharingResponse = (description: string) => ({
  description,
  content: { 'application/json': { schema: ArtifactSharingSchema } },
});

export const artifactSharingRoutes = createRouter()
  .openapi(
    createRoute({
      method: 'get',
      path: '/artifacts/{id}/sharing',
      tags: ['artifacts'],
      summary: 'Who may see an Artifact, its link, and any share request from its Bot (owner)',
      middleware: [requireUser] as const,
      security: authenticated,
      request: { params },
      responses: {
        200: sharingResponse('Its sharing'),
        ...authProblems,
        404: problemResponse('No such Artifact, or this install does not host Artifacts'),
      },
    }),
    async (c) => {
      const state = await getSharing(c.var.deps, c.var.user, c.req.valid('param').id);
      return c.json(toSharing(state), 200);
    },
  )
  .openapi(
    createRoute({
      method: 'put',
      path: '/artifacts/{id}/sharing',
      tags: ['artifacts'],
      summary: 'Change who may see an Artifact (owner; a person, for anything wider than before)',
      middleware: [requireUser] as const,
      security: authenticated,
      request: {
        params,
        body: { required: true, content: { 'application/json': { schema: SharingChangeSchema } } },
      },
      responses: {
        200: sharingResponse('Its sharing now'),
        400: problemResponse(
          '`public` without `confirmed` and `version` (`CONFIRMATION_REQUIRED`)',
        ),
        ...authProblems,
        403: problemResponse(
          'An API key widening it (`PERSON_REQUIRED`), or public links are off in the organization (`PUBLIC_SHARING_OFF`)',
        ),
        404: problemResponse(
          'No such Artifact or version, or this install does not host Artifacts',
        ),
        409: problemResponse(
          'A newer version was saved (`VERSION_CONFLICT`), or the public link was taken down (`TAKEN_DOWN`)',
        ),
      },
    }),
    async (c) => {
      const { deps, user } = c.var;
      const id = c.req.valid('param').id;
      const body = c.req.valid('json');
      // Public always needs a person. Anything else is judged by setVisibility
      // against the row it locks: whether it widens what is shared now.
      if (body.visibility === 'public') {
        requireArtifactHost(deps.config);
        await assertPerson(deps.db, user);
      }
      if (body.visibility === 'public' && (body.confirmed !== true || body.version === undefined)) {
        throw new DomainError(
          400,
          'CONFIRMATION_REQUIRED',
          'Confirm that anyone with the link will be able to view this version',
        );
      }
      const state = await setVisibility(
        deps,
        user,
        id,
        { visibility: body.visibility, version: body.version },
        { ...userActor(user), type: 'user' },
        { requireCurrent: true, caller: user },
      );
      return c.json(toSharing(state), 200);
    },
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/artifacts/{id}/open',
      tags: ['artifacts'],
      summary: 'A link that opens an Artifact on the artifact host for the caller',
      middleware: [requireUser] as const,
      security: authenticated,
      request: { params },
      responses: {
        200: {
          description: 'The link',
          content: { 'application/json': { schema: OpenLinkSchema } },
        },
        ...authProblems,
        404: problemResponse('No such Artifact the caller may see'),
        409: problemResponse('Its Bot was deleted, so it has no link (`NO_LINK`)'),
      },
    }),
    async (c) => {
      const link = await openLink(c.var.deps, c.var.user, c.req.valid('param').id);
      return c.json({ url: link.url, expiresAt: iso(link.expiresAt) }, 200);
    },
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/shared-artifacts',
      tags: ['artifacts'],
      summary: "Artifacts shared with the caller's organization, read only",
      middleware: [requireUser] as const,
      security: authenticated,
      responses: {
        200: {
          description: 'Shared Artifacts, most recently updated first',
          content: {
            'application/json': { schema: z.object({ items: z.array(SharedArtifactSchema) }) },
          },
        },
        ...authProblems,
        404: problemResponse('This install does not host Artifacts'),
      },
    }),
    async (c) => {
      const rows = await listShared(c.var.deps, c.var.user);
      return c.json({ items: rows.map((row) => toShared(row, c.var.user.id)) }, 200);
    },
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/shared-artifacts/{id}',
      tags: ['artifacts'],
      summary: 'One Artifact shared with the organization',
      middleware: [requireUser] as const,
      security: authenticated,
      request: { params },
      responses: {
        200: {
          description: 'The shared Artifact',
          content: { 'application/json': { schema: SharedArtifactSchema } },
        },
        ...authProblems,
        404: problemResponse('No such Artifact shared with the caller'),
      },
    }),
    async (c) => {
      const shared = await getShared(c.var.deps, c.var.user, c.req.valid('param').id);
      return c.json(toShared(shared, c.var.user.id), 200);
    },
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/shared-artifacts/{id}/content',
      tags: ['artifacts'],
      summary: 'The content of the version of a shared Artifact the caller may see',
      middleware: [requireUser] as const,
      security: authenticated,
      request: { params },
      responses: {
        200: {
          description: "The version's bytes, with its mime type",
          content: {
            'application/octet-stream': { schema: z.string().openapi({ format: 'binary' }) },
          },
        },
        ...authProblems,
        404: problemResponse('No such Artifact shared with the caller'),
      },
    }),
    async (c) => {
      const { artifact, version, stream } = await openShared(
        c.var.deps,
        c.var.user,
        c.req.valid('param').id,
      );
      // As the owner's content route serves it: the app's origin never runs it.
      const disposition = INLINE_MIME.has(version.mime) ? 'inline' : 'attachment';
      const name = artifactFileName(artifact.title, version.mime);
      return c.body(Readable.toWeb(stream) as ReadableStream, 200, {
        'content-type': version.mime.startsWith('text/')
          ? `${version.mime}; charset=utf-8`
          : version.mime,
        'content-length': String(version.size),
        'content-disposition': `${disposition}; filename*=UTF-8''${encodeURIComponent(name)}`,
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox",
        'cache-control': 'private, no-store',
      });
    },
  );
