import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link, redirect, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { auth } from '../app/api.js';
import { loadDeployment } from '../app/deployment.js';
import { AuthCard, AuthForm, Field } from '../features/auth/auth-form.js';
import { authErrorMessage } from '../features/auth/messages.js';
import { OAuthButtons } from '../features/auth/oauth-buttons.js';
import { setupQuery, setupRequired } from '../features/setup/api.js';

// An invite link is /sign-up?invite=<token>. Signing up is for the managed
// service: a self-hosted install has one account, made by the setup wizard,
// so this page sends visitors to sign in, which says why.

export const Route = createFileRoute('/sign-up')({
  validateSearch: (search): { invite?: string; error?: string } => ({
    invite: typeof search.invite === 'string' ? search.invite : undefined,
    error: typeof search.error === 'string' ? search.error : undefined,
  }),
  beforeLoad: async ({ context }) => {
    if (await setupRequired(() => context.queryClient.fetchQuery(setupQuery))) {
      throw redirect({ to: '/setup' });
    }
    if ((await loadDeployment(context.queryClient)) !== 'managed') {
      throw redirect({ to: '/sign-in', search: { signup: 'closed' } });
    }
  },
  component: SignUp,
});

function SignUp() {
  const { invite, error: callbackError } = Route.useSearch();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [oauthError, setOAuthError] = useState<unknown>(callbackError);
  const signUp = useMutation({
    mutationFn: auth.signUpEmail,
    onSuccess: async () => {
      queryClient.removeQueries({ queryKey: ['me'] });
      await navigate({ to: '/' });
    },
  });
  const error = signUp.error ?? oauthError;

  return (
    <AuthCard title="Create your account">
      <AuthForm
        submitLabel="Sign up"
        pending={signUp.isPending}
        error={error ? authErrorMessage(error) : null}
        onSubmit={(form) =>
          signUp.mutate({
            name: String(form.get('name')),
            email: String(form.get('email')),
            password: String(form.get('password')),
            inviteToken: invite,
          })
        }
      >
        <Field label="Name" name="name" autoComplete="name" required />
        <Field label="Email" name="email" type="email" autoComplete="email" required />
        <Field
          label="Password"
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={8}
          required
        />
      </AuthForm>
      <OAuthButtons inviteToken={invite} onError={setOAuthError} />
      <p className="text-center text-sm text-muted-foreground">
        Have an account?{' '}
        <Link to="/sign-in" className="text-foreground underline underline-offset-4">
          Sign in
        </Link>
      </p>
    </AuthCard>
  );
}
