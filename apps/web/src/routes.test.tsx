import { afterAll, describe, expect, it, vi } from 'vitest';
import { me, renderPath } from './test-utils.js';

// The API client binds `fetch` when its module loads, so the fake goes in
// before any import: it answers paths in `server.routes` and 401s the rest.
const server = vi.hoisted(() => {
  const state = { routes: {} as Record<string, unknown>, realFetch: globalThis.fetch };
  globalThis.fetch = async (input: RequestInfo | URL) => {
    const { pathname } = new URL(input instanceof Request ? input.url : String(input));
    if (!(pathname in state.routes)) {
      return Response.json({ title: 'Not signed in', status: 401 }, { status: 401 });
    }
    return Response.json(state.routes[pathname]);
  };
  return state;
});

afterAll(() => {
  globalThis.fetch = server.realFetch;
});

// The install's deployment, as /api/v1/capabilities reports it.
const capabilities = (deployment: 'self_hosted' | 'managed') => ({
  '/api/v1/capabilities': { oauth: { github: false, google: false }, computer: false, deployment },
});
const managed = capabilities('managed');
const selfHosted = capabilities('self_hosted');

describe('routes', () => {
  it('sends a signed-out visitor to sign in', async () => {
    server.routes = {};
    const { pathname, html } = await renderPath('/');
    expect(pathname).toBe('/sign-in');
    expect(html).toContain('Sign in');
  });

  it('renders the shell: New, the roster sections, the page links, no right panel', async () => {
    server.routes = { '/api/v1/me': me('member') };
    const { pathname, html } = await renderPath('/');
    expect(pathname).toBe('/');
    expect(html).toContain('New');
    for (const section of ['Pinned', 'Bots', 'Groups']) expect(html).toContain(`>${section}</h2>`);
    for (const page of ['connectors', 'skills', 'computer', 'settings']) {
      expect(html).toContain(`href="/${page}"`);
    }
    expect(html).not.toContain('<aside');
  });

  it('fits the shell to the window and scrolls only the main pane', async () => {
    server.routes = { '/api/v1/me': me('member') };
    const { html } = await renderPath('/');
    // Positioned panes keep hidden absolute elements from stretching the document.
    expect(html).toContain('data-slot="shell" class="relative flex h-dvh overflow-hidden"');
    expect(html).toContain('<main class="relative min-w-0 flex-1 overflow-auto"');
  });

  it('names the connectors page Connectors in the sidebar and the page title', async () => {
    server.routes = { '/api/v1/me': me('member') };
    const { pathname, html } = await renderPath('/connectors');
    expect(pathname).toBe('/connectors');
    expect(html).toMatch(/href="\/connectors"[^>]*>Connectors</);
    expect(html).toContain('>Connectors</h1>');
    expect(html).not.toContain('>Tools<');
  });

  it('sends an old /tools link to Connectors and keeps its search', async () => {
    server.routes = { '/api/v1/me': me('member') };
    expect((await renderPath('/tools')).pathname).toBe('/connectors');
    const { pathname, search } = await renderPath('/tools?connector=c1&oauth=connected');
    expect(pathname).toBe('/connectors');
    expect(search).toBe('?connector=c1&oauth=connected');
  });

  it('shows the Admin and Audit log settings tabs to managed admins only', async () => {
    server.routes = { ...managed, '/api/v1/me': me('admin') };
    const admin = (await renderPath('/settings/account')).html;
    expect(admin).toContain('href="/settings/admin"');
    expect(admin).toContain('href="/settings/audit"');
    expect(admin).not.toContain('href="/settings/limits"');

    server.routes = { ...managed, '/api/v1/me': me('member') };
    const member = await renderPath('/settings/account');
    expect(member.html).toContain('href="/settings/models"');
    expect(member.html).not.toContain('href="/settings/admin"');
    expect(member.html).not.toContain('href="/settings/audit"');
  });

  it('gives a self-hosted owner Limits instead of the Admin and Audit log tabs', async () => {
    for (const routes of [selfHosted, {}]) {
      server.routes = { ...routes, '/api/v1/me': me('admin') };
      const { html } = await renderPath('/settings/account');
      for (const tab of ['account', 'models', 'events', 'limits']) {
        expect(html).toContain(`href="/settings/${tab}"`);
      }
      expect(html).not.toContain('href="/settings/admin"');
      expect(html).not.toContain('href="/settings/audit"');
    }
  });

  it('sends a self-hosted owner who opens Admin or Audit log to Account', async () => {
    server.routes = { ...selfHosted, '/api/v1/me': me('admin') };
    expect((await renderPath('/settings/admin')).pathname).toBe('/settings/account');
    expect((await renderPath('/settings/audit')).pathname).toBe('/settings/account');
    expect((await renderPath('/settings/limits')).pathname).toBe('/settings/limits');

    server.routes = { ...managed, '/api/v1/me': me('admin') };
    expect((await renderPath('/settings/limits')).pathname).toBe('/settings/admin');
  });

  it('says nothing about admins to a self-hosted owner in Settings', async () => {
    server.routes = { ...selfHosted, '/api/v1/me': me('admin') };
    for (const tab of ['account', 'models', 'events', 'limits']) {
      const { html } = await renderPath(`/settings/${tab}`);
      expect(html.replace(/<[^>]*>/g, ' ')).not.toMatch(/admin/i);
      expect(html).not.toMatch(/href="\/settings\/(admin|audit)"/);
    }
  });

  it('marks the open settings tab the way the sidebar marks its open link', async () => {
    server.routes = { '/api/v1/me': me('member') };
    const { html } = await renderPath('/settings/models');
    const tab = (path: string) => html.match(new RegExp(`<a [^>]*href="${path}"[^>]*>`))![0];
    expect(tab('/settings/models')).toContain('data-status="active"');
    expect(tab('/settings/models')).toContain('aria-selected="true"');
    expect(tab('/settings/models')).toContain('data-[status=active]:bg-accent');
    expect(tab('/settings/models')).toContain('data-[status=active]:font-medium');
    expect(tab('/settings/account')).not.toContain('data-status="active"');
    expect(tab('/settings/account')).not.toContain('aria-selected');
  });

  it('sends a member who opens the Admin or Audit log tab, or bare Settings, to Account', async () => {
    server.routes = { ...managed, '/api/v1/me': me('member') };
    expect((await renderPath('/settings/admin')).pathname).toBe('/settings/account');
    expect((await renderPath('/settings/audit')).pathname).toBe('/settings/account');
    expect((await renderPath('/settings')).pathname).toBe('/settings/account');
  });

  it('opens the audit log filters for a managed admin', async () => {
    server.routes = { ...managed, '/api/v1/me': me('admin') };
    const { pathname, html } = await renderPath('/settings/audit');
    expect(pathname).toBe('/settings/audit');
    for (const label of ['Sign-in and sign-out', 'Actor id', 'From', 'To', 'Filter']) {
      expect(html).toContain(label);
    }
  });

  it('explains an invite rejection passed back from an OAuth signup', async () => {
    server.routes = { ...managed };
    const { html } = await renderPath('/sign-up?invite=obi_x&error=INVITE_INVALID');
    expect(html).toContain('This invite link is invalid');
  });

  it('sends every visitor of a new install to the setup wizard', async () => {
    server.routes = { '/api/v1/setup': { setupRequired: true } };
    for (const path of ['/', '/sign-in', '/sign-up', '/settings/models']) {
      const { pathname, html } = await renderPath(path);
      expect(pathname).toBe('/setup');
      expect(html).toContain('Create your account');
      expect(html).toContain('Your account will be its owner.');
      expect(html.replace(/<[^>]*>/g, ' ')).not.toMatch(/admin/i);
    }
  });

  it('hides the setup wizard once a user exists', async () => {
    server.routes = { '/api/v1/setup': { setupRequired: false } };
    const signedOut = await renderPath('/setup');
    expect(signedOut.pathname).toBe('/sign-in');
    expect(signedOut.html).not.toContain('Create your account');

    server.routes = { '/api/v1/setup': { setupRequired: false }, '/api/v1/me': me('admin') };
    expect((await renderPath('/setup')).pathname).toBe('/');
  });

  it('offers only sign-in on a self-hosted install once its owner exists', async () => {
    server.routes = { ...selfHosted, '/api/v1/setup': { setupRequired: false } };
    const signUp = await renderPath('/sign-up');
    expect(signUp.pathname).toBe('/sign-in');
    expect(signUp.search).toBe('?signup=closed');
    expect(signUp.html).toContain('This OpenBot has one account, its owner. Sign up is closed.');
    expect(signUp.html).not.toContain('href="/sign-up"');

    const signIn = await renderPath('/sign-in');
    expect(signIn.html).not.toContain('Sign up is closed');
    expect(signIn.html).not.toContain('href="/sign-up"');
  });

  it('keeps sign-up on the managed service', async () => {
    server.routes = { ...managed, '/api/v1/setup': { setupRequired: false } };
    expect((await renderPath('/sign-up')).pathname).toBe('/sign-up');
    expect((await renderPath('/sign-in')).html).toContain('href="/sign-up"');
  });
});
