import { ApiError } from './client.js';

// Accounts and sessions live under `/api/auth/*` (better-auth), outside the
// OpenAPI document, so these few calls are written by hand. Errors keep
// better-auth's `{ code, message }` shape and surface as `ApiError`.

export type SocialProvider = 'github' | 'google';
export type AuthClient = ReturnType<typeof createAuthClient>;

export function createAuthClient(baseUrl: string, fetchImpl: typeof fetch = fetch) {
  async function post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetchImpl(`${baseUrl}/api/auth${path}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => undefined)) as
      { code?: string; message?: string } | undefined;
    if (!res.ok) {
      throw new ApiError(res.status, { code: data?.code, detail: data?.message });
    }
    return data as T;
  }

  return {
    /**
     * `token` is null when the server wants the email verified first: a
     * link went to the address, and opening it signs in and goes to
     * `callbackURL`. `invite` is the invitation the sign-up came from.
     */
    signUpEmail: (input: {
      name: string;
      email: string;
      password: string;
      invite?: string;
      callbackURL?: string;
    }) => post<{ token: string | null }>('/sign-up/email', input),
    signInEmail: (input: { email: string; password: string; callbackURL?: string }) =>
      post<unknown>('/sign-in/email', input),
    /** Returns the provider's authorization URL to navigate to. */
    signInSocial: async (input: {
      provider: SocialProvider;
      callbackURL: string;
      errorCallbackURL?: string;
    }) => (await post<{ url: string }>('/sign-in/social', input)).url,
    signOut: () => post<unknown>('/sign-out', {}),
    /** Changes the signed-in user's own name. */
    updateUser: (input: { name: string }) => post<unknown>('/update-user', input),
  };
}
