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
// to share it waiting for the owner. Nothing becomes public without the
// confirmation dialog, which says who will be able to see it and which
// version; a newer version stays private until the owner confirms it with
// Update the public version. Shown only when the server hosts Artifacts
// (`artifactSharing` in /capabilities).

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

export const VISIBILITY_LABELS: Record<Visibility, string> = {
  private: 'Only you',
  org: 'Your organization',
  public: 'Anyone with the link',
};

const DESCRIPTIONS: Record<Visibility, string> = {
  private: 'Nobody else can see it.',
  org: 'Every member of your organization can view the latest version. Nobody can change it.',
  public: 'Anyone with the link can view the version you confirmed, without signing in.',
};

export function ShareControl({ artifactId, title }: { artifactId: string; title: string }) {
  const capabilities = useQuery(capabilitiesQuery);
  if (!capabilities.data?.artifactSharing) return null;
  return <SharePanel artifactId={artifactId} title={title} />;
}

function SharePanel({ artifactId, title }: { artifactId: string; title: string }) {
  const queryClient = useQueryClient();
  const sharing = useQuery(sharingQuery(artifactId));
  /** The version a public confirmation is for, while the dialog is open. */
  const [confirming, setConfirming] = useState<{ version: number; approvalId?: string } | null>(
    null,
  );
  const [copied, setCopied] = useState(false);

  const refresh = (next?: ArtifactSharing) => {
    if (next) queryClient.setQueryData(sharingQuery(artifactId).queryKey, next);
    return queryClient.invalidateQueries({ queryKey: ['shared-artifacts'] });
  };
  const change = useMutation({
    mutationFn: (body: { visibility: Visibility; version?: number; confirmed?: true }) =>
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
  const stale =
    state.visibility === 'public' &&
    state.publicVersion !== null &&
    current !== null &&
    state.publicVersion < current;
  const error = change.error ?? decide.error ?? open.error;
  /** A Bot asks to publish a version other than the current one (an older one: newer ones do not exist). */
  const pendingOlder =
    pending?.visibility === 'public' &&
    pending.version !== null &&
    current !== null &&
    pending.version !== current;

  function choose(next: Visibility) {
    if (next === state.visibility && next !== 'public') return;
    if (next === 'public') {
      if (current !== null) setConfirming({ version: current });
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
              (option === 'public' && state.visibility !== 'public' && !state.publicAllowed) ||
              (option === 'public' && state.takenDown) ||
              (option === 'public' && current === null)
            }
            onClick={() => choose(option)}
          >
            {VISIBILITY_LABELS[option]}
          </Button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground" data-visibility={state.visibility}>
        {DESCRIPTIONS[state.visibility]}
        {state.visibility === 'public' && state.publicVersion !== null
          ? ` The link shows version ${state.publicVersion}.`
          : ''}
      </p>
      {!state.publicAllowed && (
        <p className="text-xs text-muted-foreground">
          Your organization has turned off public links
          {state.visibility === 'public' ? ', so this link does not work now.' : '.'}
        </p>
      )}
      {state.takenDown && (
        <p className="text-xs text-destructive">
          The service took the public link to this Artifact down. It cannot be made public again.
        </p>
      )}
      {stale && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span>
            Version {current} is newer than the public one. It stays private until you confirm it.
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={!state.publicAllowed || state.takenDown}
            onClick={() => setConfirming({ version: current! })}
          >
            Update the public version
          </Button>
        </div>
      )}
      {pending && (
        <div className="flex flex-col gap-2 rounded border p-2 text-xs" role="status">
          <p>
            {pending.visibility === 'public'
              ? `Your Bot asks to make version ${pending.version ?? '?'} public, so anyone with the link could view it.`
              : 'Your Bot asks to share this with everyone in your organization.'}
            {pendingOlder &&
              ` Version ${pending.version} is not the current version. Version ${current} stays private unless you confirm it.`}
          </p>
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={decide.isPending}
              onClick={() =>
                pending.visibility === 'public'
                  ? setConfirming({ version: pending.version ?? 0, approvalId: pending.approvalId })
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
        version={confirming?.version ?? null}
        current={current}
        busy={change.isPending || decide.isPending}
        onCancel={() => setConfirming(null)}
        onConfirm={() => {
          if (!confirming) return;
          if (confirming.approvalId) {
            decide.mutate({ approvalId: confirming.approvalId, decision: 'approve' });
          } else {
            change.mutate({ visibility: 'public', version: confirming.version, confirmed: true });
          }
        }}
      />
    </section>
  );
}

/** The one step before anything becomes public: who will see it, and which version. */
function ConfirmPublic({
  title,
  version,
  current,
  busy,
  onCancel,
  onConfirm,
}: {
  title: string;
  version: number | null;
  /** The current version, said when it is not the one being published. */
  current: number | null;
  busy: boolean;
  onCancel(): void;
  onConfirm(): void;
}) {
  return (
    <Dialog open={version !== null} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Make this public?</DialogTitle>
          <DialogDescription>
            Anyone with the link will be able to view version {version} of “{title}”, without
            signing in. It is not limited to your organization. Later versions stay private until
            you confirm them. You can stop sharing at any time.
            {version !== null && current !== null && version !== current
              ? ` This is not the current version: that is version ${current}.`
              : ''}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button disabled={busy} onClick={onConfirm}>
            Make version {version} public
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
