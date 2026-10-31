import { ApiError } from '@openbot/api-client';

// Signup policy rejections (U1) and disabled accounts (U3) carry stable codes; everything else shows the
// server's own message. Invites and disabled accounts are the managed service's; a self-hosted
// install closes sign-up once its owner exists.

const MESSAGES: Record<string, string> = {
  INVITE_REQUIRED: 'Signing up here needs an invite. Open the link from your invite.',
  INVITE_INVALID: 'This invite link is invalid, already used, or expired.',
  ACCOUNT_DISABLED: 'This account is disabled. Ask an admin to enable it.',
  SIGNUP_CLOSED: 'This OpenBot already has its owner. Sign in instead.',
  NOT_OWNER: 'This OpenBot has one account, its owner.',
  EMAIL_NOT_VERIFIED: 'Confirm your email first. Sign in to get a new code.',
  INVALID_OTP: 'That code is wrong. Try again.',
  OTP_EXPIRED: 'That code expired. Send a new one.',
  TOO_MANY_ATTEMPTS: 'Too many tries. Send a new code.',
};

export function authErrorMessage(error: unknown): string {
  if (error instanceof ApiError) return (error.code && MESSAGES[error.code]) || error.message;
  if (typeof error === 'string') return MESSAGES[error] ?? 'Sign-in failed. Try again.';
  return 'Something went wrong. Try again.';
}
