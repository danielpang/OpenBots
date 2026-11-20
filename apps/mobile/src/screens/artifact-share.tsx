import { Alert, Linking, Share, View } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { unwrap, type components } from '@openbots/api-client';
import { useApi } from '../api/provider';
import { Button, Label, row } from '../components/ui';

// Who can see an Artifact, on the phone (plan 21.11): the same core routes
// and rules as the web app. Nothing becomes public before the confirmation,
// which says who will see it and which version; a newer version waits for
// "Update the public version"; a Bot's request is answered here too. A
// server that does not host Artifacts, or predates sharing, answers 404 and
// the section stays hidden.

export type ArtifactSharing = components['schemas']['ArtifactSharing'];
type Visibility = ArtifactSharing['visibility'];

const LABELS: Record<Visibility, string> = {
  private: 'Only you',
  org: 'Your organization',
  public: 'Anyone with the link',
};

const DESCRIPTIONS: Record<Visibility, string> = {
  private: 'Nobody else can see it.',
  org: 'Every member of your organization can view the latest version. Nobody can change it.',
  public: 'Anyone with the link can view the version you confirmed, without signing in.',
};

export const sharingKey = (id: string) => ['artifacts', id, 'sharing'] as const;

/**
 * Asks before anything becomes public; resolves true only on the person's
 * yes. Says so when the version is not the current one.
 */
export function confirmPublic(
  title: string,
  version: number,
  current: number | null = version,
): Promise<boolean> {
  const older =
    current !== null && current !== version
      ? ` This is not the current version: that is version ${current}.`
      : '';
  return new Promise((resolve) =>
    Alert.alert(
      'Make this public?',
      `Anyone with the link will be able to view version ${version} of “${title}”, without signing in. It is not limited to your organization. Later versions stay private until you confirm them.${older}`,
      [
        { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
        { text: `Make version ${version} public`, onPress: () => resolve(true) },
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
    mutationFn: (body: { visibility: Visibility; version?: number; confirmed?: true }) =>
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
  const stale =
    state.visibility === 'public' &&
    state.publicVersion !== null &&
    current !== null &&
    state.publicVersion < current;
  const busy = change.isPending || decide.isPending;

  async function makePublic(version: number) {
    if (await confirmPublic(title, version)) {
      change.mutate({ visibility: 'public', version, confirmed: true });
    }
  }

  function choose(next: Visibility) {
    if (next === 'public') {
      if (current !== null) void makePublic(current);
    } else if (next !== state!.visibility) {
      change.mutate({ visibility: next });
    }
  }

  async function approve(approvalId: string, visibility: 'org' | 'public', version: number | null) {
    if (visibility === 'public' && !(await confirmPublic(title, version ?? 0, current))) return;
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
                (state.takenDown ||
                  current === null ||
                  (!state.publicAllowed && state.visibility !== 'public')))
            }
            onPress={() => choose(option)}
          />
        ))}
      </View>
      <Label muted size={14}>
        {DESCRIPTIONS[state.visibility]}
        {state.visibility === 'public' && state.publicVersion !== null
          ? ` The link shows version ${state.publicVersion}.`
          : ''}
      </Label>
      {!state.publicAllowed ? (
        <Label muted size={14}>
          Your organization has turned off public links.
        </Label>
      ) : null}
      {state.takenDown ? (
        <Label size={14}>
          The service took the public link down. It cannot be made public again.
        </Label>
      ) : null}
      {stale ? (
        <View style={{ gap: 8 }}>
          <Label size={14}>
            Version {current} is newer than the public one. It stays private until you confirm it.
          </Label>
          <Button
            title="Update the public version"
            variant="secondary"
            disabled={busy || !state.publicAllowed || state.takenDown}
            onPress={() => void makePublic(current!)}
          />
        </View>
      ) : null}
      {pending ? (
        <View style={{ gap: 8 }}>
          <Label size={14}>
            {pending.visibility === 'public'
              ? `Your Bot asks to make version ${pending.version ?? '?'} public, so anyone with the link could view it.`
              : 'Your Bot asks to share this with everyone in your organization.'}
            {pending.visibility === 'public' &&
            pending.version !== null &&
            current !== null &&
            pending.version !== current
              ? ` Version ${pending.version} is not the current version. Version ${current} stays private unless you confirm it.`
              : ''}
          </Label>
          <View style={[row.base, { gap: 8 }]}>
            <Button
              title="Approve"
              disabled={busy}
              onPress={() => void approve(pending.approvalId, pending.visibility, pending.version)}
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
