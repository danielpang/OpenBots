import { Alert, Linking, Share, View } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { unwrap, type components } from '@openbots/api-client';
import { useApi } from '../api/provider';
import { Button, Label, row } from '../components/ui';

// Who can see an Artifact, on the phone (plan 21.11): the same core routes
// and rules as the web app. Whoever can see it sees its latest version.
// Nothing becomes public before the confirmation, which says who will see it
// and that later edits, a Bot's included, are public at once; public is
// offered only when the organization turned public links on; a Bot's request
// is answered here too. A server that does not host Artifacts, or predates
// sharing, answers 404 and the section stays hidden.

export type ArtifactSharing = components['schemas']['ArtifactSharing'];
type Visibility = ArtifactSharing['visibility'];

const LABELS: Record<Visibility, string> = {
  private: 'Only you',
  org: 'Your organization',
  public: 'Anyone with the link',
};

const DESCRIPTIONS: Record<Visibility, string> = {
  private: 'Nobody else can see it.',
  org: 'Every member of your organization can view the latest version. Nobody else can change it.',
  public: 'Anyone with the link can view the latest version, without signing in.',
};

/** What making an Artifact public means for later edits, in one sentence (as on the web). */
export const PUBLIC_EDITS_NOTE =
  'Every later edit, including one your Bot makes, is public as soon as it is saved, without asking you again.';

export const sharingKey = (id: string) => ['artifacts', id, 'sharing'] as const;

/** Asks before anything becomes public; resolves true only on the person's yes. */
export function confirmPublic(title: string): Promise<boolean> {
  return new Promise((resolve) =>
    Alert.alert(
      'Make this public?',
      `Anyone with the link will be able to view “${title}” without signing in. It is not limited to your organization. ${PUBLIC_EDITS_NOTE}`,
      [
        { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
        { text: 'Make it public', onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    ),
  );
}

export function ArtifactShare({ id, title }: { id: string; title: string }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const sharing = useQuery({
    queryKey: sharingKey(id),
    queryFn: async () => {
      const result = await api.GET('/api/v1/artifacts/{id}/sharing', {
        params: { path: { id } },
      });
      if (result.response.status === 404) return null;
      return unwrap(Promise.resolve(result));
    },
  });
  const change = useMutation({
    mutationFn: (body: { visibility: Visibility; confirmed?: true }) =>
      unwrap(api.PUT('/api/v1/artifacts/{id}/sharing', { params: { path: { id } }, body })),
    onSuccess: (next) => queryClient.setQueryData(sharingKey(id), next),
    onError: (error) => Alert.alert('Could not change who can see it', message(error)),
  });
  const decide = useMutation({
    mutationFn: ({ approvalId, decision }: { approvalId: string; decision: 'approve' | 'deny' }) =>
      unwrap(
        api.POST('/api/v1/approvals/{id}/decide', {
          params: { path: { id: approvalId } },
          body: { decision },
        }),
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: sharingKey(id) }),
    onError: (error) => Alert.alert('Could not answer the request', message(error)),
  });
  const open = useMutation({
    mutationFn: async () => {
      const { url } = await unwrap(
        api.POST('/api/v1/artifacts/{id}/open', { params: { path: { id } } }),
      );
      await Linking.openURL(url);
    },
    onError: (error) => Alert.alert('Could not open it', message(error)),
  });

  const state = sharing.data;
  if (!state) return null;
  const current = state.currentVersion;
  const pending = state.pendingRequest;
  const busy = change.isPending || decide.isPending;
  /** Why public cannot be chosen now, or null when it can. */
  const publicBlocked = state.takenDown
    ? 'The service took the public link down. It cannot be made public again.'
    : !state.publicAllowed
      ? 'Public links are off for your organization. An owner or admin can turn them on in Settings.'
      : null;

  async function makePublic() {
    if (await confirmPublic(title)) change.mutate({ visibility: 'public', confirmed: true });
  }

  function choose(next: Visibility) {
    if (next === state!.visibility) return;
    if (next === 'public') {
      if (current !== null && !publicBlocked) void makePublic();
    } else {
      change.mutate({ visibility: next });
    }
  }

  async function approve(approvalId: string, visibility: 'org' | 'public') {
    if (visibility === 'public' && !(await confirmPublic(title))) return;
    decide.mutate({ approvalId, decision: 'approve' });
  }

  return (
    <View style={{ padding: 18, gap: 10 }} accessibilityLabel="Who can see it">
      <Label size={15} weight="600" muted>
        Who can see it
      </Label>
      <View style={[row.base, { flexWrap: 'wrap', gap: 8 }]}>
        {(['private', 'org', 'public'] as const).map((option) => (
          <Button
            key={option}
            title={LABELS[option]}
            variant={state.visibility === option ? 'primary' : 'secondary'}
            accessibilityLabel={
              state.visibility === option ? `${LABELS[option]}, chosen` : LABELS[option]
            }
            disabled={
              busy ||
              (option === 'public' &&
                state.visibility !== 'public' &&
                (publicBlocked !== null || current === null))
            }
            onPress={() => choose(option)}
          />
        ))}
      </View>
      <Label muted size={14}>
        {DESCRIPTIONS[state.visibility]}
      </Label>
      {publicBlocked ? (
        <Label muted={!state.takenDown} size={14}>
          {publicBlocked}
        </Label>
      ) : null}
      {pending ? (
        <View style={{ gap: 8 }}>
          <Label size={14}>
            {pending.visibility === 'public'
              ? 'Your Bot asks to make this public, so anyone with the link could view it and every later version.'
              : 'Your Bot asks to share this with everyone in your organization, so members could view it and every later version.'}
          </Label>
          <View style={[row.base, { gap: 8 }]}>
            <Button
              title="Approve"
              disabled={busy || (pending.visibility === 'public' && publicBlocked !== null)}
              onPress={() => void approve(pending.approvalId, pending.visibility)}
            />
            <Button
              title="Deny"
              variant="secondary"
              disabled={busy}
              onPress={() => decide.mutate({ approvalId: pending.approvalId, decision: 'deny' })}
            />
          </View>
        </View>
      ) : null}
      {state.noLink ? (
        <Label muted size={14}>
          {state.noLink === 'address_too_long'
            ? "This organization's address is too long for a link, so this Artifact cannot be opened in the browser."
            : 'The Bot that made this Artifact was deleted, so it has no link.'}
        </Label>
      ) : null}
      {state.url ? (
        <View style={[row.base, { flexWrap: 'wrap', gap: 8 }]}>
          {state.visibility !== 'private' ? (
            <Button
              title="Share link"
              icon="link-outline"
              variant="secondary"
              onPress={() => void Share.share({ url: state.url!, message: state.url! })}
            />
          ) : null}
          <Button
            title="Open in browser"
            icon="open-outline"
            variant="secondary"
            loading={open.isPending}
            onPress={() => open.mutate()}
          />
        </View>
      ) : null}
    </View>
  );
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
