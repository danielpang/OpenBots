import { createAuthClient, createClient, unwrap, type AuthClient } from '@openbots/api-client';
import { normalizeServerUrl } from '../transport';
import { pairHost, parsePairingLink } from '../hosts/pairing';

/** Use the native session cookie only to mint a one-use device pairing. The
 * password and session never enter the host store; all later traffic uses the
 * independently revocable device key, including APNs registration. */
export async function signInAndPair(
  input: {
    address: string;
    email: string;
    password: string;
    deviceName: string;
  },
  fetchImpl: typeof fetch = fetch,
) {
  return sessionAndPair(
    {
      address: input.address,
      deviceName: input.deviceName,
      signIn: (auth) => auth.signInEmail({ email: input.email.trim(), password: input.password }),
    },
    fetchImpl,
  );
}

/** The same with any sign-in that sets the session cookie (Sign in with Apple's ID token). */
export async function sessionAndPair(
  input: { address: string; deviceName: string; signIn(auth: AuthClient): Promise<unknown> },
  fetchImpl: typeof fetch = fetch,
) {
  const origin = normalizeServerUrl(input.address);
  const auth = createAuthClient(origin, fetchImpl);
  await input.signIn(auth);
  try {
    const api = createClient(origin, fetchImpl);
    const offer = await unwrap(
      api.POST('/api/v1/devices/pairings', {
        body: { name: input.deviceName, direct: [origin] },
      }),
    );
    return await pairHost(parsePairingLink(offer.link), {
      deviceName: input.deviceName,
      fetch: fetchImpl,
    });
  } finally {
    // Device credentials are independent of the short-lived sign-in cookie.
    await auth.signOut().catch(() => {});
  }
}
