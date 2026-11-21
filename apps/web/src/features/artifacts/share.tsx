import type { components } from '@openbots/api-client';
import { unwrap } from '@openbots/api-client';
import {
  Button,
  CopyIcon,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  ExternalIcon,
} from '@openbots/ui';
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, capabilitiesQuery } from '../../app/api.js';

// Sharing an Artifact (plan 21.11), in the viewer: who can see it now, a
// change to it, the link to copy and Open in browser, and a Bot's request
// to share it waiting for the owner. Whoever can see it sees its latest
// version. Nothing becomes public without the confirmation dialog, which
// says who will be able to see it and that later edits, a Bot's included,
// are public at once. Public is offered only when an owner or admin turned
// public links on for the organization. Shown only when the server hosts
// Artifacts (`artifactSharing` in /capabilities).

export type ArtifactSharing = components['schemas']['ArtifactSharing'];
type Visibility = ArtifactSharing['visibility'];

export const sharingQuery = (artifactId: string) =>
  queryOptions({
    queryKey: ['artifacts', artifactId, 'sharing'],
    queryFn: () =>
      unwrap(api.GET('/api/v1/artifacts/{id}/sharing', { params: { path: { id: artifactId } } })),
  });

/** Opens the Artifact on the artifact host in a new tab, with a view token for this one Artifact. */
export async function openInBrowser(artifactId: string) {
  // Opened before the request, so the browser does not block it as a popup.
  const tab = window.open('', '_blank');
  try {
    const { url } = await unwrap(
      api.POST('/api/v1/artifacts/{id}/open', { params: { path: { id: artifactId } } }),
    );
    if (tab) {
      tab.opener = null;
      tab.location.href = url;
    } else {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  } catch (error) {
    tab?.close();
    throw error;
  }
}

/** What making an Artifact public means for later edits, in one sentence. */
export const PUBLIC_EDITS_NOTE =
  'Every later edit, including one your Bot makes, is public as soon as it is saved, without asking you again.';

export const VISIBILITY_LABELS: Record<Visibility, string> = {
  private: 'Only you',
  org: 'Your organization',
  public: 'Anyone with the link',
};

const DESCRIPTIONS: Record<Visibility, string> = {
  private: 'Nobody else can see it.',
  org: 'Every member of your organization can view the latest version. Nobody else can change it.',
  public: 'Anyone with the link can view the latest version, without signing in.',
};

export function ShareControl({ artifactId, title }: { artifactId: string; title: string }) {
  const capabilities = useQuery(capabilitiesQuery);
  if (!capabilities.data?.artifactSharing) return null;
  return <SharePanel artifactId={artifactId} title={title} />;
}

function SharePanel({ artifactId, title }: { artifactId: string; title: string }) {
  const queryClient = useQueryClient();
  const sharing = useQuery(sharingQuery(artifactId));
  /** A public confirmation, while the dialog is open: the owner's own, or a Bot's request. */
  const [confirming, setConfirming] = useState<{ approvalId?: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const refresh = (next?: ArtifactSharing) => {
    if (next) queryClient.setQueryData(sharingQuery(artifactId).queryKey, next);
    return queryClient.invalidateQueries({ queryKey: ['shared-artifacts'] });
  };
  const change = useMutation({
    mutationFn: (body: { visibility: Visibility; confirmed?: true }) =>
      unwrap(
        api.PUT('/api/v1/artifacts/{id}/sharing', {
          params: { path: { id: artifactId } },
          body,
        }),
      ),
    onSuccess: (next) => {
      setConfirming(null);
      void refresh(next);
    },
  });
  const decide = useMutation({
    mutationFn: ({ approvalId, decision }: { approvalId: string; decision: 'approve' | 'deny' }) =>
      unwrap(
        api.POST('/api/v1/approvals/{id}/decide', {
          params: { path: { id: approvalId } },
          body: { decision },
        }),
      ),
    onSuccess: async () => {
      setConfirming(null);
      // The Bot's run applies an approved request; read the result once it has.
      await queryClient.invalidateQueries({ queryKey: sharingQuery(artifactId).queryKey });
      await refresh();
    },
  });
  const open = useMutation({ mutationFn: () => openInBrowser(artifactId) });

  if (sharing.error) return null;
  if (!sharing.data) return null;
  const state = sharing.data;
  const current = state.currentVersion;
  const pending = state.pendingRequest;
  const error = change.error ?? decide.error ?? open.error;
  /** Why the public option cannot be chosen now, or null when it can. */
  const publicBlocked = state.takenDown
    ? 'The service took the public link to this Artifact down. It cannot be made public again.'
    : !state.publicAllowed
      ? 'Public links are off for your organization. An owner or admin can turn them on in Settings.'
      : null;

  function choose(next: Visibility) {
    if (next === state.visibility) return;
    if (next === 'public') {
      if (current !== null && !publicBlocked) setConfirming({});
      return;
    }
    change.mutate({ visibility: next });
  }

  async function copy() {
    if (!state.url) return;
    await navigator.clipboard?.writeText(state.url);
    setCopied(true);
    setTimeout(() => setCopied(false), 1_500);
  }

  return (
    <section className="flex flex-col gap-2 border-t pt-3" aria-label="Sharing">
      <h4 className="text-xs font-medium text-muted-foreground">Who can see it</h4>
      <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Who can see it">
        {(['private', 'org', 'public'] as const).map((option) => (
          <Button
            key={option}
            size="sm"
            role="radio"
            aria-checked={state.visibility === option}
            variant={state.visibility === option ? 'secondary' : 'outline'}
            disabled={
              change.isPending ||
              (option === 'public' &&
                state.visibility !== 'public' &&
                (publicBlocked !== null || current === null))
            }
            title={option === 'public' && publicBlocked ? publicBlocked : undefined}
            onClick={() => choose(option)}
          >
            {VISIBILITY_LABELS[option]}
          </Button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground" data-visibility={state.visibility}>
        {DESCRIPTIONS[state.visibility]}
      </p>
      {publicBlocked && (
        <p
          className={state.takenDown ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}
          data-testid="public-blocked"
        >
          {publicBlocked}
        </p>
      )}
      {pending && (
        <div className="flex flex-col gap-2 rounded border p-2 text-xs" role="status">
          <p>
            {pending.visibility === 'public'
              ? 'Your Bot asks to make this public, so anyone with the link could view it and every later version.'
              : 'Your Bot asks to share this with everyone in your organization, so members could view it and every later version.'}
            {pending.visibility === 'public' && publicBlocked ? ` ${publicBlocked}` : ''}
          </p>
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={decide.isPending || (pending.visibility === 'public' && !!publicBlocked)}
              onClick={() =>
                pending.visibility === 'public'
                  ? setConfirming({ approvalId: pending.approvalId })
                  : decide.mutate({ approvalId: pending.approvalId, decision: 'approve' })
              }
            >
              Approve
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={decide.isPending}
              onClick={() => decide.mutate({ approvalId: pending.approvalId, decision: 'deny' })}
            >
              Deny
            </Button>
          </div>
        </div>
      )}
      {state.noLink && (
        <p className="text-xs text-muted-foreground">
          {state.noLink === 'address_too_long'
            ? "This organization's address is too long for a link, so this Artifact cannot be opened in the browser."
            : 'The Bot that made this Artifact was deleted, so it has no link.'}
        </p>
      )}
      {state.url && (
        <div className="flex flex-wrap gap-1">
          {state.visibility !== 'private' && (
            <Button size="sm" variant="outline" onClick={() => void copy()}>
              <CopyIcon />
              {copied ? 'Copied' : 'Copy link'}
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={() => open.mutate()}>
            <ExternalIcon />
            Open in browser
          </Button>
        </div>
      )}
      {error && <p className="text-xs text-destructive">{error.message}</p>}
      <ConfirmPublic
        title={title}
        open={confirming !== null}
        busy={change.isPending || decide.isPending}
        onCancel={() => setConfirming(null)}
        onConfirm={() => {
          if (!confirming) return;
          if (confirming.approvalId) {
            decide.mutate({ approvalId: confirming.approvalId, decision: 'approve' });
          } else {
            change.mutate({ visibility: 'public', confirmed: true });
          }
        }}
      />
    </section>
  );
}

/** The one step before anything becomes public: who will see it, now and after every edit. */
function ConfirmPublic({
  title,
  open,
  busy,
  onCancel,
  onConfirm,
}: {
  title: string;
  open: boolean;
  busy: boolean;
  onCancel(): void;
  onConfirm(): void;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Make this public?</DialogTitle>
          <DialogDescription>
            Anyone with the link will be able to view “{title}” without signing in. It is not
            limited to your organization. {PUBLIC_EDITS_NOTE} You can stop sharing at any time.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button disabled={busy} onClick={onConfirm}>
            Make it public
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
