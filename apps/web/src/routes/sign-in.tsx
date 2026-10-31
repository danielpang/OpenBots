import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link, redirect, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { auth } from '../app/api.js';
import { loadDeployment } from '../app/deployment.js';
import { AuthCard, AuthForm, Field } from '../features/auth/auth-form.js';
import { authErrorMessage } from '../features/auth/messages.js';
import { OAuthButtons } from '../features/auth/oauth-buttons.js';
import { setupQuery, setupRequired } from '../features/setup/api.js';

// A self-hosted install has one account, so there is no Sign up link;
// `?signup=closed` (from /sign-up) says why.

export const Route = createFileRoute('/sign-in')({
  validateSearch: (search): { error?: string; signup?: 'closed' } => ({
    error: typeof search.error === 'string' ? search.error : undefined,
    signup: search.signup === 'closed' ? 'closed' : undefined,
  }),
  beforeLoad: async ({ context }) => {
    if (await setupRequired(() => context.queryClient.fetchQuery(setupQuery))) {
      throw redirect({ to: '/setup' });
    }
    return { deployment: await loadDeployment(context.queryClient) };
  },
  component: SignIn,
});

function SignIn() {
  const search = Route.useSearch();
  const { deployment } = Route.useRouteContext();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [oauthError, setOAuthError] = useState<unknown>(search.error);
  const signIn = useMutation({
    mutationFn: auth.signInEmail,
    onSuccess: async () => {
      queryClient.removeQueries({ queryKey: ['me'] });
      await navigate({ to: '/' });
    },
  });
  const error = signIn.error ?? oauthError;

  return (
    <AuthCard title="Sign in">
      {search.signup === 'closed' && deployment !== 'managed' && (
        <p role="status" className="text-center text-sm text-muted-foreground">
          This OpenBot has one account, its owner. Sign up is closed.
        </p>
      )}
      <AuthForm
        submitLabel="Sign in"
        pending={signIn.isPending}
        error={error ? authErrorMessage(error) : null}
        onSubmit={(form) =>
          signIn.mutate({
            email: String(form.get('email')),
            password: String(form.get('password')),
          })
        }
      >
        <Field label="Email" name="email" type="email" autoComplete="email" required />
        <Field
          label="Password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
        />
      </AuthForm>
      <OAuthButtons onError={setOAuthError} />
      {deployment === 'managed' && (
        <p className="text-center text-sm text-muted-foreground">
          No account?{' '}
          <Link to="/sign-up" className="text-foreground underline underline-offset-4">
            Sign up
          </Link>
        </p>
      )}
    </AuthCard>
  );
}
