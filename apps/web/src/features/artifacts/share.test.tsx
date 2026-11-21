// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PublicLinksSetting, stopLinksText, stoppedLinksText } from '../settings/admin-settings.js';
import { ShareControl, type ArtifactSharing } from './share.js';
import { SharedArtifactsPage, type SharedArtifact } from './shared-page.js';

// The share control in the Artifact viewer, the list of what is shared with
// the organization and the organization's public links switch (plan 21.11),
// against a fake REST server: nothing becomes public before the
// confirmation, which says who will see it and that later edits are public
// at once; public is offered only when the organization turned it on; a
// Bot's request is answered here; an admin can stop sharing others' rows.

const ID = '00000000-0000-4000-8000-0000000000a1';
const APPROVAL = '00000000-0000-4000-8000-0000000000c1';

const server = vi.hoisted(() => {
  const state = {
    realFetch: globalThis.fetch,
    sharingOn: true,
    sharing: null as unknown as ArtifactSharing,
    role: 'member' as 'owner' | 'admin' | 'member',
    settings: { publicArtifactsEnabled: true, publicArtifacts: 0 } as {
      publicArtifactsEnabled: boolean;
      publicArtifacts: number;
      publicLinksStopped?: number;
    },
    shared: [] as SharedArtifact[],
    /** Items after the first page of the shared list, served when it is asked for by cursor. */
    sharedNext: [] as SharedArtifact[],
    requests: [] as { method: string; path: string; body: unknown; query?: string }[],
    handle: (async () => Response.error()) as (request: Request) => Promise<Response>,
  };
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) =>
    state.handle(input instanceof Request ? input : new Request(String(input), init));
  return state;
});

const sharing = (over: Partial<ArtifactSharing> = {}): ArtifactSharing => ({
  visibility: 'private',
  currentVersion: 2,
  publicAllowed: true,
  takenDown: false,
  url: `https://writer-1a2b3c4d--acme-0f0f0f0f.openbots-artifacts.example/${ID}/`,
  noLink: null,
  sharedAt: null,
  pendingRequest: null,
  ...over,
});

beforeEach(() => {
  server.sharingOn = true;
  server.sharing = sharing();
  server.role = 'member';
  server.settings = { publicArtifactsEnabled: true, publicArtifacts: 0 };
  server.shared = [];
  server.sharedNext = [];
  server.requests = [];
  server.handle = async (request) => {
    const { pathname, searchParams } = new URL(request.url, 'http://localhost');
    const body = request.method === 'GET' ? undefined : await request.json().catch(() => undefined);
    server.requests.push({
      method: request.method,
      path: pathname,
      body,
      query: `${searchParams}`,
    });
    if (pathname === '/api/v1/capabilities') {
      return Response.json({
        oauth: { github: false, google: false },
        deployment: 'managed',
        artifactSharing: server.sharingOn,
      });
    }
    if (pathname === '/api/v1/me') {
      return Response.json({ user: { id: 'u1', name: 'Me' }, role: server.role, workspace: null });
    }
    if (pathname === '/api/v1/settings') {
      if (request.method === 'PATCH') {
        const patch = body as { publicArtifactsEnabled: boolean };
        const stopped = patch.publicArtifactsEnabled ? 0 : server.settings.publicArtifacts;
        server.settings = {
          publicArtifactsEnabled: patch.publicArtifactsEnabled,
          publicArtifacts: patch.publicArtifactsEnabled ? server.settings.publicArtifacts : 0,
        };
        return Response.json({ ...server.settings, publicLinksStopped: stopped });
      }
      return Response.json(server.settings);
    }
    if (pathname.endsWith('/sharing') && request.method === 'PUT') {
      const change = body as { visibility: ArtifactSharing['visibility'] };
      if (pathname !== `/api/v1/artifacts/${ID}/sharing`) {
        server.shared = server.shared.filter((i) => !pathname.includes(i.id));
        return Response.json(sharing({ visibility: change.visibility }));
      }
      server.sharing = { ...server.sharing, visibility: change.visibility };
      return Response.json(server.sharing);
    }
    if (pathname === `/api/v1/artifacts/${ID}/sharing`) return Response.json(server.sharing);
    if (pathname === `/api/v1/artifacts/${ID}/open`) {
      return Response.json({ url: `${server.sharing.url}?token=t`, expiresAt: null });
    }
    if (pathname === `/api/v1/approvals/${APPROVAL}/decide`) {
      server.sharing = { ...server.sharing, pendingRequest: null };
      return Response.json({ approval: { id: APPROVAL }, resumedRunId: null });
    }
    if (pathname === '/api/v1/shared-artifacts') {
      if (searchParams.get('cursor') === 'page-2') {
        return Response.json({ items: server.sharedNext, nextCursor: null });
      }
      return Response.json({
        items: server.shared,
        nextCursor: server.sharedNext.length ? 'page-2' : null,
      });
    }
    return Response.json({ title: 'Not found' }, { status: 404 });
  };
});
afterAll(() => {
  globalThis.fetch = server.realFetch;
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLElement;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
});

function render(ui: ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>));
}

async function until(check: () => boolean, what: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (check()) return;
    await act(() => new Promise((r) => setTimeout(r, 10)));
  }
  if (check()) return;
  throw new Error(`timed out waiting for ${what}: ${document.body.textContent}`);
}

const button = (label: string) =>
  [...document.body.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === label || b.getAttribute('aria-label') === label,
  );
const click = (label: string) => act(() => button(label)!.click());
const puts = () => server.requests.filter((r) => r.method === 'PUT').map((r) => r.body);
const text = () => document.body.textContent ?? '';

describe('<ShareControl>', () => {
  it('stays hidden when the server does not host Artifacts', async () => {
    server.sharingOn = false;
    render(<ShareControl artifactId={ID} title="Plan" />);
    await until(() => server.requests.some((r) => r.path === '/api/v1/capabilities'), 'caps');
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(host.textContent).toBe('');
    expect(server.requests.some((r) => r.path.endsWith('/sharing'))).toBe(false);
  });

  it('shows who can see it and shares with the organization in one step', async () => {
    render(<ShareControl artifactId={ID} title="Plan" />);
    await until(() => text().includes('Nobody else can see it.'), 'the state');
    expect(button('Only you')!.getAttribute('aria-checked')).toBe('true');
    // A private Artifact offers Open in browser, but no link to copy.
    expect(button('Open in browser')).toBeDefined();
    expect(button('Copy link')).toBeUndefined();
    click('Your organization');
    await until(() => text().includes('Every member of your organization'), 'org');
    expect(puts()).toEqual([{ visibility: 'org' }]);
    expect(button('Copy link')).toBeDefined();
  });

  it('makes nothing public before the person confirms who will see it, now and after every edit', async () => {
    render(<ShareControl artifactId={ID} title="Plan" />);
    await until(() => !!button('Anyone with the link'), 'the options');
    click('Anyone with the link');
    await until(() => text().includes('Make this public?'), 'the dialog');
    expect(text()).toContain(
      'Anyone with the link will be able to view “Plan” without signing in.',
    );
    expect(text()).toContain('It is not limited to your organization.');
    // The one plain sentence about later edits, a Bot's included.
    expect(text()).toContain(
      'Every later edit, including one your Bot makes, is public as soon as it is saved, without asking you again.',
    );
    expect(text()).not.toMatch(/version \d/);
    expect(puts()).toEqual([]);
    click('Cancel');
    await until(() => !text().includes('Make this public?'), 'the dialog to close');
    expect(puts()).toEqual([]);

    click('Anyone with the link');
    await until(() => !!button('Make it public'), 'the dialog again');
    click('Make it public');
    await until(() => text().includes('can view the latest version, without signing in'), 'public');
    expect(puts()).toEqual([{ visibility: 'public', confirmed: true }]);
    // Nothing to update after an edit: the link always shows the latest version.
    expect(button('Update the public version')).toBeUndefined();
  });

  it('offers no public option, and says why, while the organization has public links off', async () => {
    server.sharing = sharing({ publicAllowed: false });
    render(<ShareControl artifactId={ID} title="Plan" />);
    await until(() => text().includes('Public links are off for your organization.'), 'the note');
    expect(text()).toContain('An owner or admin can turn them on in Settings.');
    expect(button('Anyone with the link')!.disabled).toBe(true);
    // Sharing with the organization still works.
    expect(button('Your organization')!.disabled).toBe(false);
  });

  it("answers a Bot's request to make it public through the same confirmation", async () => {
    server.sharing = sharing({
      pendingRequest: {
        approvalId: APPROVAL,
        visibility: 'public',
        createdAt: '2026-11-19T10:00:00.000Z',
      },
    });
    render(<ShareControl artifactId={ID} title="Plan" />);
    await until(() => text().includes('Your Bot asks to make this public'), 'the request');
    expect(text()).toContain('anyone with the link could view it and every later version');
    click('Approve');
    await until(() => !!button('Make it public'), 'the dialog');
    expect(text()).toContain('including one your Bot makes');
    expect(server.requests.some((r) => r.path.endsWith('/decide'))).toBe(false);
    click('Make it public');
    await until(() => server.requests.some((r) => r.path.endsWith('/decide')), 'the decision');
    expect(server.requests.find((r) => r.path.endsWith('/decide'))!.body).toEqual({
      decision: 'approve',
    });
  });

  it("cannot approve a Bot's public request while public links are off", async () => {
    server.sharing = sharing({
      publicAllowed: false,
      pendingRequest: {
        approvalId: APPROVAL,
        visibility: 'public',
        createdAt: '2026-11-19T10:00:00.000Z',
      },
    });
    render(<ShareControl artifactId={ID} title="Plan" />);
    await until(() => text().includes('Your Bot asks to make this public'), 'the request');
    expect(button('Approve')!.disabled).toBe(true);
    expect(button('Deny')!.disabled).toBe(false);
  });

  it('says why an Artifact has no link', async () => {
    server.sharing = sharing({ url: null, noLink: 'address_too_long' });
    render(<ShareControl artifactId={ID} title="Plan" />);
    await until(() => text().includes('Nobody else can see it.'), 'the state');
    expect(text()).toContain(
      "This organization's address is too long for a link, so this Artifact cannot be opened in the browser.",
    );
    expect(button('Open in browser')).toBeUndefined();
    act(() => root!.unmount());
    server.sharing = sharing({ url: null, noLink: 'bot_deleted' });
    render(<ShareControl artifactId={ID} title="Plan" />);
    await until(() => text().includes('Nobody else can see it.'), 'the state again');
    expect(text()).toContain('The Bot that made this Artifact was deleted, so it has no link.');
  });

  it('opens the Artifact in the browser with a link the server mints', async () => {
    const tab = { opener: {}, location: { href: '' }, close: vi.fn() };
    const open = vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
    render(<ShareControl artifactId={ID} title="Plan" />);
    await until(() => !!button('Open in browser'), 'the button');
    click('Open in browser');
    await until(() => tab.location.href !== '', 'the tab');
    expect(tab.location.href).toBe(`${server.sharing.url}?token=t`);
    expect(tab.opener).toBeNull();
    open.mockRestore();
  });
});

describe('<SharedArtifactsPage>', () => {
  it('lists what is shared with the organization, read only', async () => {
    server.shared = [
      {
        id: ID,
        kind: 'document',
        title: 'Roadmap',
        visibility: 'org',
        version: { version: 3, mime: 'text/markdown', size: 10, createdAt: '2026-11-19T10:00:00Z' },
        ownerName: 'Alice',
        botName: 'Writer',
        mine: false,
        url: `https://writer-1a2b3c4d--acme-0f0f0f0f.openbots-artifacts.example/${ID}/`,
        updatedAt: '2026-11-19T10:00:00.000Z',
      },
    ];
    render(<SharedArtifactsPage />);
    await until(() => text().includes('Roadmap'), 'the list');
    expect(text()).toContain('Document · v3 · Alice with Writer');
    expect(text()).toContain('only their owner can change them');
    expect(button('Open Roadmap in the browser')).toBeDefined();
    expect(button('Edit')).toBeUndefined();
  });

  it("gives an owner or admin a control to stop sharing someone else's row, and no one else", async () => {
    const row = (id: string, title: string, mine: boolean): SharedArtifact => ({
      id,
      kind: 'document',
      title,
      visibility: 'public',
      version: { version: 1, mime: 'text/markdown', size: 1, createdAt: '2026-11-19T10:00:00Z' },
      ownerName: mine ? 'Me' : 'Carol',
      botName: null,
      mine,
      url: null,
      updatedAt: '2026-11-19T10:00:00.000Z',
    });
    const theirs = '00000000-0000-4000-8000-0000000000d1';
    server.shared = [row(theirs, 'Carol plan', false), row(ID, 'My plan', true)];
    render(<SharedArtifactsPage />);
    await until(() => text().includes('Carol plan'), 'the list');
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(button('Stop sharing Carol plan')).toBeUndefined();
    act(() => root!.unmount());

    server.role = 'admin';
    render(<SharedArtifactsPage />);
    await until(() => !!button('Stop sharing Carol plan'), 'the admin control');
    expect(button('Stop sharing My plan')).toBeUndefined();
    click('Stop sharing Carol plan');
    expect(puts()).toEqual([]);
    click('Make Carol plan private');
    await until(() => !text().includes('Carol plan'), 'the row to go');
    expect(server.requests.filter((r) => r.method === 'PUT').map((r) => [r.path, r.body])).toEqual([
      [`/api/v1/artifacts/${theirs}/sharing`, { visibility: 'private' }],
    ]);
  });

  it('loads more a page at a time', async () => {
    const item = (n: number): SharedArtifact => ({
      id: `00000000-0000-4000-8000-0000000000b${n}`,
      kind: 'document',
      title: `Doc ${n}`,
      visibility: 'org',
      version: { version: 1, mime: 'text/markdown', size: 1, createdAt: '2026-11-19T10:00:00Z' },
      ownerName: 'Alice',
      botName: null,
      mine: false,
      url: null,
      updatedAt: '2026-11-19T10:00:00.000Z',
    });
    server.shared = [item(1)];
    server.sharedNext = [item(2)];
    render(<SharedArtifactsPage />);
    await until(() => text().includes('Doc 1') && !!button('Load more'), 'the first page');
    expect(text()).not.toContain('Doc 2');
    click('Load more');
    await until(() => text().includes('Doc 2'), 'the second page');
    expect(button('Load more')).toBeUndefined();
    const asked = server.requests.filter((r) => r.path === '/api/v1/shared-artifacts');
    expect(asked.map((r) => new URLSearchParams(r.query).get('cursor'))).toEqual([null, 'page-2']);
  });
});

describe('<PublicLinksSetting>', () => {
  it('turns public links on in one step, and says how many links stop before turning them off', async () => {
    server.settings = { publicArtifactsEnabled: false, publicArtifacts: 0 };
    render(<PublicLinksSetting />);
    await until(() => text().includes('Allow public links'), 'the switch');
    expect(text()).toContain('Off by default.');
    const toggle = () =>
      act(() =>
        (host.querySelector('input[name="publicArtifactsEnabled"]') as HTMLElement).click(),
      );
    toggle();
    await until(() => server.settings.publicArtifactsEnabled, 'on');
    // Three Artifacts are public now; turning off asks first.
    server.settings = { publicArtifactsEnabled: true, publicArtifacts: 3 };
    act(() => root!.unmount());
    render(<PublicLinksSetting />);
    await until(() => text().includes('Allow public links'), 'the switch again');
    toggle();
    await until(() => text().includes('Turn off public links?'), 'the confirmation');
    expect(text()).toContain('3 public links stop working.');
    expect(server.requests.filter((r) => r.method === 'PATCH')).toHaveLength(1);
    click('Turn off public links');
    await until(() => !server.settings.publicArtifactsEnabled, 'off');
    expect(server.requests.filter((r) => r.method === 'PATCH').map((r) => r.body)).toEqual([
      { publicArtifactsEnabled: true },
      { publicArtifactsEnabled: false },
    ]);
  });

  it('counts the public links again when the switch is turned off, and says afterwards how many stopped', async () => {
    server.settings = { publicArtifactsEnabled: true, publicArtifacts: 0 };
    render(<PublicLinksSetting />);
    await until(() => text().includes('Allow public links'), 'the switch');
    // Someone makes two Artifacts public after the page loaded with none.
    server.settings = { publicArtifactsEnabled: true, publicArtifacts: 2 };
    act(() => (host.querySelector('input[name="publicArtifactsEnabled"]') as HTMLElement).click());
    await until(() => text().includes('Turn off public links?'), 'the confirmation');
    expect(text()).toContain('2 public links stop working.');
    expect(server.requests.filter((r) => r.method === 'PATCH')).toHaveLength(0);
    // A third is made public while the admin reads it: the answer says three stopped.
    server.settings = { publicArtifactsEnabled: true, publicArtifacts: 3 };
    click('Turn off public links');
    await until(() => text().includes('3 public links stopped working.'), 'what stopped');
    expect(server.settings.publicArtifactsEnabled).toBe(false);
  });

  it('says the count plainly', () => {
    expect(stopLinksText(0)).toBe('No Artifact is public now.');
    expect(stopLinksText(1)).toContain('1 public link stops working.');
    expect(stopLinksText(2)).toContain('owner has to make it public again one by one');
    expect(stoppedLinksText(0)).toBe('Public links are off. No link was public.');
    expect(stoppedLinksText(1)).toBe('Public links are off. 1 public link stopped working.');
    expect(stoppedLinksText(3)).toBe('Public links are off. 3 public links stopped working.');
  });
});
