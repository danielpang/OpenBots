import type { SocialProvider } from '@openbot/api-client';
import { Button } from '@openbot/ui';
import { useQuery } from '@tanstack/react-query';
import { auth, capabilitiesQuery } from '../../app/api.js';

const LABELS: Record<SocialProvider, string> = { github: 'GitHub', google: 'Google' };

/** One button per sign-in provider the server has configured; nothing otherwise. */
export function OAuthButtons({
  inviteToken,
  onError,
}: {
  inviteToken?: string;
  onError(error: unknown): void;
}) {
  const { data } = useQuery(capabilitiesQuery);
  const providers = (Object.keys(LABELS) as SocialProvider[]).filter((p) => data?.oauth[p]);
  if (!providers.length) return null;

  async function start(provider: SocialProvider) {
    // An OAuth signup carries its invite in this cookie (server invites.ts).
    if (inviteToken) {
      document.cookie = `openbot_invite=${encodeURIComponent(inviteToken)}; path=/; max-age=600; samesite=lax`;
    }
    try {
      const errorCallbackURL = window.location.pathname + window.location.search;
      window.location.href = await auth.signInSocial({
        provider,
        callbackURL: '/',
        errorCallbackURL,
      });
    } catch (error) {
      onError(error);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      {providers.map((provider) => (
        <Button key={provider} variant="outline" onClick={() => void start(provider)}>
          {`Continue with ${LABELS[provider]}`}
        </Button>
      ))}
    </div>
  );
}
