import { Button } from '@openbot/ui';
import { useMutation } from '@tanstack/react-query';
import { auth } from '../../app/api.js';
import { AuthCard, AuthForm, Field } from './auth-form.js';
import { authErrorMessage } from './messages.js';

// The step after signing up, or signing in before confirming (plan 21.6):
// the server emailed a 6-digit code, good for 10 minutes and 5 tries.
// Entering it confirms the address and signs in.

export function CheckEmail({ email, onConfirmed }: { email: string; onConfirmed(): unknown }) {
  const verify = useMutation({
    mutationFn: auth.verifyEmail,
    onSuccess: () => onConfirmed(),
  });
  const resend = useMutation({
    mutationFn: auth.sendVerificationCode,
    onSuccess: () => verify.reset(),
  });
  const error = verify.error ?? resend.error;

  return (
    <AuthCard title="Check your email">
      <p className="text-center text-sm text-muted-foreground">
        We sent a 6-digit code to {email}.
      </p>
      <AuthForm
        submitLabel="Confirm"
        pending={verify.isPending}
        error={error ? authErrorMessage(error) : null}
        onSubmit={(form) => verify.mutate({ email, code: String(form.get('code')).trim() })}
      >
        <Field
          label="Code"
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]{6}"
          maxLength={6}
          required
          autoFocus
        />
      </AuthForm>
      <div className="flex flex-col items-center gap-2">
        <Button
          variant="ghost"
          disabled={resend.isPending}
          onClick={() => resend.mutate({ email })}
        >
          Send a new code
        </Button>
        {resend.isSuccess && (
          <p role="status" className="text-sm text-muted-foreground">
            Sent. Check your email.
          </p>
        )}
      </div>
    </AuthCard>
  );
}
