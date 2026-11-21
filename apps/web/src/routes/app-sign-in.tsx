import { ApiError, unwrap } from '@openbots/api-client';
import { Button } from '@openbots/ui';
import { useMutation } from '@tanstack/react-query';
import { createFileRoute, redirect } from '@tanstack/react-router';
import { useState } from 'react';
import { api, meQuery } from '../app/api.js';
import { loadAuthMode } from '../app/deployment.js';
import { isActive } from '../app/extensions.js';
import { AuthCard } from '../features/auth/auth-form.js';
import {
  appRedirect,
  platformName,
  readAppSignIn,
  savePendingAppSignIn,
  type AppSignInRequest,
} from '../features/auth/app-sign-in.js';
import { authErrorMessage } from '../features/auth/messages.js';

// The iOS or Mac app opened the browser here to sign in
// (features/auth/app-sign-in.ts). Signed out, or with no organization yet,
// the request waits while the person signs in, signs up or joins one; then
// they confirm, and the browser goes back into the app with a one-time code.

export const Route = createFileRoute('/app-sign-in')({
  validateSearch: (search): Record<string, unknown> => search,
  beforeLoad: async ({ context, search }) => {
    const request = readAppSignIn(search);
    if (!request) return { request: null, me: null };
    // The Mac app running this install signs itself in; there is nothing to hand over.
    if ((await loadAuthMode(context.queryClient)) === 'local') return { request: null, me: null };
    try {
      const me = await context.queryClient.fetchQuery({ ...meQuery, staleTime: 0 });
      if (!isActive(me)) {
        savePendingAppSignIn(request);
        throw redirect({ to: '/onboarding' });
      }
      return { request, me };
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        savePendingAppSignIn(request);
        throw redirect({ to: '/sign-in' });
      }
      throw error;
    }
  },
  component: AppSignInPage,
});

function AppSignInPage() {
  const { request, me } = Route.useRouteContext();
  if (!request || !me || !isActive(me)) {
    return (
      <AuthCard title="Open the app again">
        <p className="text-center text-sm text-muted-foreground">
          This sign-in link is incomplete. Start signing in from the OpenBots app again.
        </p>
      </AuthCard>
    );
  }
  return (
    <Confirm request={request} name={me.user.name} email={me.user.email} org={me.workspace.name} />
  );
}

function Confirm({
  request,
  name,
  email,
  org,
}: {
  request: AppSignInRequest;
  name: string;
  email: string;
  org: string;
}) {
  const [done, setDone] = useState<'signed-in' | 'cancelled' | null>(null);
  const confirm = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST('/api/v1/app-sign-in/codes', {
          body: { platform: request.platform, codeChallenge: request.challenge },
        }),
      ),
    onSuccess: ({ code }) => {
      setDone('signed-in');
      window.location.href = appRedirect(request.state, { code });
    },
  });
  function cancel() {
    setDone('cancelled');
    window.location.href = appRedirect(request.state, { error: 'cancelled' });
  }

  if (done) {
    return (
      <AuthCard title={done === 'signed-in' ? 'Back to the app' : 'Cancelled'}>
        <p className="text-center text-sm text-muted-foreground">
          {done === 'signed-in'
            ? 'OpenBots should open now. You can close this window.'
            : 'Nothing was signed in. You can close this window.'}
        </p>
      </AuthCard>
    );
  }
  return (
    <AuthCard title="Sign in to the app">
      <p className="text-center text-sm text-muted-foreground">
        Sign in to {platformName(request.platform)} as {name} ({email}) in {org}? Continue only if
        you started this from the app yourself.
      </p>
      {confirm.error && (
        <p role="alert" className="text-sm text-destructive">
          {authErrorMessage(confirm.error)}
        </p>
      )}
      <Button disabled={confirm.isPending} onClick={() => confirm.mutate()}>
        Continue
      </Button>
      <Button variant="outline" disabled={confirm.isPending} onClick={cancel}>
        Cancel
      </Button>
    </AuthCard>
  );
}
