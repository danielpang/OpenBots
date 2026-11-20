import { z } from 'zod';

// Artifact kinds (plan 4.8, A1). The pg enum `artifact_kind` holds the same
// values; document, code and data are text and get line diffs, inline
// editing and patches (plan 12.1).

export const ARTIFACT_KINDS = ['document', 'code', 'data', 'design', 'file'] as const;

export const ArtifactKindSchema = z.enum(ARTIFACT_KINDS);

export type ArtifactKind = z.infer<typeof ArtifactKindSchema>;

export const TEXT_ARTIFACT_KINDS: readonly ArtifactKind[] = ['document', 'code', 'data'];

export function isTextArtifactKind(kind: ArtifactKind): boolean {
  return TEXT_ARTIFACT_KINDS.includes(kind);
}

// Who may see an Artifact (plan 21.11). `private`, the default, is its owner
// only; `org` is every active member of its organization, read only;
// `public` is anyone with the link, while the organization has public links
// on. Everyone who may see it sees its latest version. Widening it always
// needs a person: a Bot only asks (`REQUEST_ARTIFACT_SHARE_TOOL`), and that
// request never runs unasked.

export const ARTIFACT_VISIBILITIES = ['private', 'org', 'public'] as const;

export const ArtifactVisibilitySchema = z.enum(ARTIFACT_VISIBILITIES);

export type ArtifactVisibility = z.infer<typeof ArtifactVisibilitySchema>;

/** The tool a Bot calls to ask its owner to share an Artifact. */
export const REQUEST_ARTIFACT_SHARE_TOOL = 'request_artifact_share';
