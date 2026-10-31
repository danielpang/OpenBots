import type { QueryClient } from '@tanstack/react-query';
import { meQuery } from '../../app/api.js';

// Where sign-in and sign-up go next: the app, or with an invite, /onboarding
// to accept it (plan 21.5).

export function afterAuth(invite: string | undefined) {
  return invite ? ({ to: '/onboarding', search: { invite } } as const) : ({ to: '/' } as const);
}

/** Whether a session is signed in now, asking the server afresh. */
export function signedIn(queryClient: QueryClient): Promise<boolean> {
  return queryClient.fetchQuery({ ...meQuery, staleTime: 0 }).then(
    () => true,
    () => false,
  );
}
