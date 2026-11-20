import { unwrap, type components } from '@openbots/api-client';
import { Button, ExternalIcon } from '@openbots/ui';
import { ARTIFACT_KIND_LABELS, ArtifactKindIcon } from '@openbots/widgets/react';
import { Link } from '@tanstack/react-router';
import {
  infiniteQueryOptions,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useState } from 'react';
import { api, capabilitiesQuery, meQuery } from '../../app/api.js';
import { isAdmin } from '../../app/extensions.js';
import { openInBrowser } from './share.js';
import { formatWhen } from './viewer.js';

// Shared with your organization (plan 21.11): the Artifacts members shared
// with the organization, and those made public, as each member may see
// them, read only. A row opens the Artifact in the browser on the artifact
// host. Nothing else of the owner's is reachable from here. An owner or
// admin of the organization can stop sharing anyone's row (to private),
// which is how what a suspended or removed member shared is stopped; they
// never widen it. In the sidebar only when the server hosts Artifacts.

export type SharedArtifact = components['schemas']['SharedArtifact'];

export const sharedArtifactsQuery = infiniteQueryOptions({
  queryKey: ['shared-artifacts'],
  queryFn: ({ pageParam }) =>
    unwrap(
      api.GET('/api/v1/shared-artifacts', {
        params: { query: { ...(pageParam ? { cursor: pageParam } : {}), limit: 50 } },
      }),
    ),
  initialPageParam: '',
  getNextPageParam: (page) => page.nextCursor ?? undefined,
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
  const shared = useInfiniteQuery(sharedArtifactsQuery);
  const me = useQuery(meQuery);
  const admin = isAdmin(me.data?.role);
  const queryClient = useQueryClient();
  const open = useMutation({ mutationFn: (id: string) => openInBrowser(id) });
  /** The row an admin is about to stop sharing, while they confirm. */
  const [stopping, setStopping] = useState<string | null>(null);
  const stop = useMutation({
    mutationFn: (id: string) =>
      unwrap(
        api.PUT('/api/v1/artifacts/{id}/sharing', {
          params: { path: { id } },
          body: { visibility: 'private' },
        }),
      ),
    onSuccess: () => {
      setStopping(null);
      return queryClient.invalidateQueries({ queryKey: sharedArtifactsQuery.queryKey });
    },
  });
  if (shared.error) return <p className="p-8 text-sm text-destructive">{shared.error.message}</p>;
  if (!shared.data) return <p className="p-8 text-sm text-muted-foreground">Loading…</p>;
  const items = shared.data.pages.flatMap((page) => page.items);
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 p-8">
      <p className="text-sm text-muted-foreground">
        Artifacts people in your organization shared. You can view them; only their owner can change
        them.
        {admin ? ' As an owner or admin you can stop sharing any of them.' : ''}
      </p>
      {!items.length ? (
        <p className="text-sm text-muted-foreground">Nothing is shared yet.</p>
      ) : (
        <ul className="divide-y rounded-md border">
          {items.map((item) => (
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
              {admin && !item.mine && stopping !== item.id && (
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Stop sharing ${item.title}`}
                  onClick={() => setStopping(item.id)}
                >
                  Stop sharing
                </Button>
              )}
              {admin && !item.mine && stopping === item.id && (
                <span className="flex items-center gap-1">
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={stop.isPending}
                    aria-label={`Make ${item.title} private`}
                    onClick={() => stop.mutate(item.id)}
                  >
                    Make private
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setStopping(null)}>
                    Cancel
                  </Button>
                </span>
              )}
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
      {shared.hasNextPage && (
        <Button
          variant="outline"
          className="self-start"
          disabled={shared.isFetchingNextPage}
          onClick={() => void shared.fetchNextPage()}
        >
          Load more
        </Button>
      )}
      {open.error && <p className="text-sm text-destructive">{open.error.message}</p>}
      {stop.error && <p className="text-sm text-destructive">{stop.error.message}</p>}
    </div>
  );
}
