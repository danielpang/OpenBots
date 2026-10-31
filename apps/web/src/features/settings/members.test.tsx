// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { meQuery } from '../../app/api.js';
import { me } from '../../test-utils.js';
import { INVITE_DAYS, inviteLink, invitePayload, MembersSettings } from './members.js';

// Settings > Admin, users and invites (U1, U3): the invite form with its
// one-time link, pending invites with Revoke, and members with role and
// disable controls.

const ADA = me('admin').user.id;
const BOB = '00000000-0000-4000-8000-0000000000b0';

const member = (over: Record<string, unknown>) => ({
  id: ADA,
  name: 'Ada',
  email: 'ada@example.com',
  role: 'admin',
  createdAt: '2026-10-01T00:00:00.000Z',
  disabledAt: null,
  botCount: 1,
  ...over,
});

const server = vi.hoisted(() => {
  const state = {
    realFetch: globalThis.fetch,
    requests: [] as { method: string; path: string; body: unknown }[],
    members: [] as Record<string, unknown>[],
    invites: [] as Record<string, unknown>[],
    patchReply: null as null | Response,
  };
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const path = new URL(request.url).pathname;
    const text = request.method === 'GET' ? '' : await request.text();
    const body = text ? (JSON.parse(text) as Record<string, unknown>) : null;
    state.requests.push({ method: request.method, path, body });
    if (path === '/api/v1/admin/members') return Response.json({ items: state.members });
    if (path === '/api/v1/admin/invites' && request.method === 'GET') {
      return Response.json({ items: state.invites });
    }
    if (path === '/api/v1/admin/invites') {
      return Response.json(
        {
          id: 'i-new',
          token: 'obi_secret',
          email: body?.email ?? null,
          role: body?.role,
          expiresAt: '2026-11-01T00:00:00.000Z',
        },
        { status: 201 },
      );
    }
    if (request.method === 'DELETE') return new Response(null, { status: 204 });
    if (request.method === 'PATCH') {
      if (state.patchReply) return state.patchReply;
      const id = path.split('/').at(-1);
      const current = state.members.find((m) => m.id === id)!;
      return Response.json({
        ...current,
        ...(body?.role ? { role: body.role } : {}),
        ...(body?.disabled === undefined
          ? {}
          : { disabledAt: body.disabled ? '2026-10-29T00:00:00.000Z' : null }),
      });
    }
    return Response.json({ title: 'Not found' }, { status: 404 });
  };
  return state;
});
afterAll(() => {
  globalThis.fetch = server.realFetch;
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLElement;
const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));
const button = (text: string, within: ParentNode = host) =>
  [...within.querySelectorAll('button')].find((b) => b.textContent === text);
const row = (email: string) => host.querySelector<HTMLElement>(`[data-member="${email}"]`)!;
const requests = (method: string) => server.requests.filter((r) => r.method === method);

beforeEach(async () => {
  server.requests.length = 0;
  server.patchReply = null;
  server.members = [
    member({}),
    member({ id: BOB, name: 'Bob', email: 'bob@example.com', role: 'member', botCount: 3 }),
  ];
  server.invites = [
    {
      id: 'i1',
      email: 'carol@example.com',
      role: 'member',
      createdAt: '2026-10-28T00:00:00.000Z',
      expiresAt: '2026-11-04T00:00:00.000Z',
      createdBy: 'ada@example.com',
    },
    {
      id: 'i2',
      email: null,
      role: 'admin',
      createdAt: '2026-10-28T00:00:00.000Z',
      expiresAt: '2026-11-04T00:00:00.000Z',
      createdBy: 'ada@example.com',
    },
  ];
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(meQuery.queryKey, me('admin') as never);
  act(() =>
    root.render(
      <QueryClientProvider client={client}>
        <MembersSettings />
      </QueryClientProvider>,
    ),
  );
  // Both lists loaded (the requests can take a few ticks under load).
  await vi.waitFor(async () => {
    await settle();
    expect(host.querySelector('[data-member="bob@example.com"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="Pending invites"]')!.textContent).toContain('carol');
  });
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('invite helpers', () => {
  it('builds the sign-up link and the request body', () => {
    expect(inviteLink('obi_a+b', 'https://openbot.example.com')).toBe(
      'https://openbot.example.com/sign-up?invite=obi_a%2Bb',
    );
    const form = new FormData();
    form.set('email', '  ');
    form.set('role', 'member');
    expect(invitePayload(form)).toEqual({ role: 'member', expiresInDays: INVITE_DAYS });
    form.set('email', 'carol@example.com');
    form.set('role', 'admin');
    expect(invitePayload(form)).toEqual({
      email: 'carol@example.com',
      role: 'admin',
      expiresInDays: INVITE_DAYS,
    });
  });
});

describe('<MembersSettings>', () => {
  it('creates an invite and shows its link once, with Copy', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const email = host.querySelector<HTMLInputElement>('[aria-label="Invite email"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        email,
        'dan@example.com',
      );
    });
    await act(async () => host.querySelector('form')!.requestSubmit());
    await settle();
    expect(requests('POST')).toEqual([
      {
        method: 'POST',
        path: '/api/v1/admin/invites',
        body: { email: 'dan@example.com', role: 'member', expiresInDays: INVITE_DAYS },
      },
    ]);
    const link = host.querySelector<HTMLInputElement>('[aria-label="Invite link"]')!;
    expect(link.value).toBe(`${window.location.origin}/sign-up?invite=obi_secret`);
    expect(host.textContent).toContain('It is shown only once');
    await act(async () => button('Copy')!.click());
    expect(writeText).toHaveBeenCalledWith(link.value);
    expect(button('Copied')).toBeDefined();
    // The pending list is read again.
    expect(
      server.requests.filter((r) => r.method === 'GET' && r.path === '/api/v1/admin/invites'),
    ).toHaveLength(2);
  });

  it('lists pending invites and revokes one', async () => {
    const list = host.querySelector('[aria-label="Pending invites"]')!;
    expect(list.textContent).toContain('carol@example.com');
    expect(list.textContent).toContain('Anyone with the link');
    expect(list.textContent).toContain('Admin, expires');
    await act(async () => button('Revoke', list)!.click());
    await settle();
    expect(requests('DELETE').map((r) => r.path)).toEqual(['/api/v1/admin/invites/i1']);
  });

  it('lists members with role and Bot count, and says what Disable keeps', () => {
    expect(row('ada@example.com').textContent).toContain('(you)');
    expect(row('bob@example.com').textContent).toContain('bob@example.com, 3 Bots, joined');
    expect(host.textContent).toContain('their data stays');
    // No Disable on your own row.
    expect(button('Disable', row('ada@example.com'))).toBeUndefined();
  });

  it('disables and enables a member, and changes a role', async () => {
    await act(async () => button('Disable', row('bob@example.com'))!.click());
    await settle();
    expect(requests('PATCH').at(-1)).toEqual({
      method: 'PATCH',
      path: `/api/v1/admin/members/${BOB}`,
      body: { disabled: true },
    });
    expect(row('bob@example.com').textContent).toContain('Disabled');
    expect(button('Enable', row('bob@example.com'))).toBeDefined();

    const role = row('bob@example.com').querySelector('select')!;
    await act(async () => {
      role.value = 'admin';
      role.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await settle();
    expect(requests('PATCH').at(-1)?.body).toEqual({ role: 'admin' });
    expect(row('bob@example.com').querySelector('select')!.value).toBe('admin');
  });

  it('shows why the server refused a change', async () => {
    server.patchReply = Response.json(
      {
        type: 'about:blank',
        title: 'The workspace needs an admin who can sign in. Make someone else an admin first.',
        status: 409,
        code: 'LAST_ADMIN',
      },
      { status: 409, headers: { 'content-type': 'application/problem+json' } },
    );
    const role = row('ada@example.com').querySelector('select')!;
    await act(async () => {
      role.value = 'member';
      role.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await settle();
    expect(host.textContent).toContain('The workspace needs an admin who can sign in.');
    expect(row('ada@example.com').querySelector('select')!.value).toBe('admin');
  });
});
