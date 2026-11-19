import { unwrap, type components } from '@openbots/api-client';
import { Button, ExternalIcon } from '@openbots/ui';
import { ARTIFACT_KIND_LABELS, ArtifactKindIcon } from '@openbots/widgets/react';
import { Link } from '@tanstack/react-router';
import { queryOptions, useMutation, useQuery } from '@tanstack/react-query';
import { api, capabilitiesQuery } from '../../app/api.js';
import { openInBrowser } from './share.js';
import { formatWhen } from './viewer.js';

// Shared with your organization (plan 21.11): the Artifacts members shared
// with the organization, and those made public, as each member may see
// them, read only. A row opens the Artifact in the browser on the artifact
// host. Nothing else of the owner's is reachable from here. In the sidebar
// only when the server hosts Artifacts.

export type SharedArtifact = components['schemas']['SharedArtifact'];

export const sharedArtifactsQuery = queryOptions({
  queryKey: ['shared-artifacts'],
  queryFn: async () => (await unwrap(api.GET('/api/v1/shared-artifacts'))).items,
});

export function SharedArtifactsLink() {
  const capabilities = useQuery(capabilitiesQuery);
  if (!capabilities.data?.artifactSharing) return null;
  return (
    <Link
      to="/shared"
      className="rounded-md px-2 py-1.5 text-sm hover:bg-accent"
      activeProps={{ className: 'bg-accent font-medium' }}
    >
      Shared
    </Link>
  );
}

export function SharedArtifactsPage() {
  const shared = useQuery(sharedArtifactsQuery);
  const open = useMutation({ mutationFn: (id: string) => openInBrowser(id) });
  if (shared.error) return <p className="p-8 text-sm text-destructive">{shared.error.message}</p>;
  if (!shared.data) return <p className="p-8 text-sm text-muted-foreground">Loading…</p>;
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 p-8">
      <p className="text-sm text-muted-foreground">
        Artifacts people in your organization shared. You can view them; only their owner can change
        them.
      </p>
      {!shared.data.length ? (
        <p className="text-sm text-muted-foreground">Nothing is shared yet.</p>
      ) : (
        <ul className="divide-y rounded-md border">
          {shared.data.map((item) => (
            <li key={item.id} className="flex items-center gap-3 px-3 py-2 text-sm">
              <ArtifactKindIcon kind={item.kind} className="shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{item.title}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {ARTIFACT_KIND_LABELS[item.kind]} · v{item.version.version} ·{' '}
                  {item.mine ? 'You' : item.ownerName}
                  {item.botName ? ` with ${item.botName}` : ''}
                  {item.visibility === 'public' ? ' · Public' : ''}
                </p>
              </div>
              <span className="w-36 shrink-0 text-right text-xs text-muted-foreground">
                {formatWhen(item.updatedAt)}
              </span>
              {item.url ? (
                <Button
                  size="sm"
                  variant="outline"
                  aria-label={`Open ${item.title} in the browser`}
                  onClick={() => open.mutate(item.id)}
                >
                  <ExternalIcon />
                  Open
                </Button>
              ) : (
                <Button size="sm" variant="outline" asChild>
                  <a
                    href={`/api/v1/shared-artifacts/${encodeURIComponent(item.id)}/content`}
                    download
                  >
                    Download
                  </a>
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {open.error && <p className="text-sm text-destructive">{open.error.message}</p>}
    </div>
  );
}
