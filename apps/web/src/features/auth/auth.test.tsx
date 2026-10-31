import { ApiError } from '@openbot/api-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { capabilitiesQuery } from '../../app/api.js';
import { authErrorMessage } from './messages.js';
import { OAuthButtons } from './oauth-buttons.js';

function renderButtons(oauth: { github: boolean; google: boolean }) {
  const queryClient = new QueryClient();
  queryClient.setQueryData(capabilitiesQuery.queryKey, { oauth, deployment: 'self_hosted' });
  return renderToString(
    <QueryClientProvider client={queryClient}>
      <OAuthButtons onError={() => {}} />
    </QueryClientProvider>,
  );
}

describe('OAuth buttons', () => {
  it('shows only the providers the server has configured', () => {
    const html = renderButtons({ github: true, google: false });
    expect(html).toContain('Continue with GitHub');
    expect(html).not.toContain('Google');
  });

  it('renders nothing when no provider is configured', () => {
    expect(renderButtons({ github: false, google: false })).toBe('');
  });
});

describe('auth error messages', () => {
  it('explains signup policy rejections', () => {
    expect(authErrorMessage(new ApiError(403, { code: 'INVITE_REQUIRED' }))).toMatch(
      /needs an invite/,
    );
    expect(authErrorMessage(new ApiError(403, { code: 'INVITE_INVALID' }))).toMatch(/invalid/);
    expect(authErrorMessage('INVITE_REQUIRED')).toMatch(/needs an invite/);
    expect(authErrorMessage(new ApiError(403, { code: 'ACCOUNT_DISABLED' }))).toBe(
      'This account is disabled. Ask an admin to enable it.',
    );
  });

  it('passes other server messages through', () => {
    expect(authErrorMessage(new ApiError(401, { detail: 'Invalid email or password' }))).toBe(
      'Invalid email or password',
    );
  });
});
