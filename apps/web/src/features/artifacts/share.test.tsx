// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ShareControl, type ArtifactSharing } from './share.js';
import { SharedArtifactsPage, type SharedArtifact } from './shared-page.js';

// The share control in the Artifact viewer and the list of what is shared
// with the organization (plan 21.11), against a fake REST server: nothing
// becomes public before the confirmation, which names the version and who
// will see it; a newer version waits for "Update the public version"; a
// Bot's request is answered here.

const ID = '00000000-0000-4000-8000-0000000000a1';
const APPROVAL = '00000000-0000-4000-8000-0000000000c1';

const server = vi.hoisted(() => {
  const state = {
    realFetch: globalThis.fetch,
    sharingOn: true,
    sharing: null as unknown as ArtifactSharing,
    shared: [] as SharedArtifact[],
    requests: [] as { method: string; path: string; body: unknown }[],
    handle: (async () => Response.error()) as (request: Request) => Promise<Response>,
  };
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) =>
    state.handle(input instanceof Request ? input : new Request(String(input), init));
  return state;
});

const sharing = (over: Partial<ArtifactSharing> = {}): ArtifactSharing => ({
  visibility: 'private',
  currentVersion: 2,
  publicVersion: null,
  publicAllowed: true,
  takenDown: false,
  url: `https://writer-1a2b3c4d--acme-0f0f0f0f.openbots-artifacts.example/${ID}/`,
  sharedAt: null,
  pendingRequest: null,
  ...over,
});

beforeEach(() => {
  server.sharingOn = true;
  server.sharing = sharing();
  server.shared = [];
  server.requests = [];
  server.handle = async (request) => {
    const { pathname } = new URL(request.url, 'http://localhost');
    const body = request.method === 'GET' ? undefined : await request.json().catch(() => undefined);
    server.requests.push({ method: request.method, path: pathname, body });
    if (pathname === '/api/v1/capabilities') {
      return Response.json({
        oauth: { github: false, google: false },
        deployment: 'managed',
        artifactSharing: server.sharingOn,
      });
    }
    if (pathname === `/api/v1/artifacts/${ID}/sharing` && request.method === 'PUT') {
      const change = body as { visibility: ArtifactSharing['visibility']; version?: number };
      server.sharing = {
        ...server.sharing,
        visibility: change.visibility,
        publicVersion: change.visibility === 'public' ? (change.version ?? null) : null,
      };
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
    if (pathname === '/api/v1/shared-artifacts') return Response.json({ items: server.shared });
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

  it('makes nothing public before the person confirms who will see it and which version', async () => {
    render(<ShareControl artifactId={ID} title="Plan" />);
    await until(() => !!button('Anyone with the link'), 'the options');
    click('Anyone with the link');
    await until(() => text().includes('Make this public?'), 'the dialog');
    expect(text()).toContain(
      'Anyone with the link will be able to view version 2 of “Plan”, without signing in.',
    );
    expect(text()).toContain('It is not limited to your organization.');
    expect(puts()).toEqual([]);
    click('Cancel');
    await until(() => !text().includes('Make this public?'), 'the dialog to close');
    expect(puts()).toEqual([]);

    click('Anyone with the link');
    await until(() => !!button('Make version 2 public'), 'the dialog again');
    click('Make version 2 public');
    await until(() => text().includes('The link shows version 2.'), 'public');
    expect(puts()).toEqual([{ visibility: 'public', version: 2, confirmed: true }]);
  });

  it('keeps a newer version private until "Update the public version" is confirmed', async () => {
    server.sharing = sharing({ visibility: 'public', publicVersion: 2, currentVersion: 4 });
    render(<ShareControl artifactId={ID} title="Plan" />);
    await until(() => text().includes('Version 4 is newer than the public one'), 'the notice');
    click('Update the public version');
    await until(() => !!button('Make version 4 public'), 'the dialog');
    click('Make version 4 public');
    await until(() => text().includes('The link shows version 4.'), 'updated');
    expect(puts()).toEqual([{ visibility: 'public', version: 4, confirmed: true }]);
  });

  it('says when the organization turned public links off, and offers no public option', async () => {
    server.sharing = sharing({ publicAllowed: false });
    render(<ShareControl artifactId={ID} title="Plan" />);
    await until(() => text().includes('turned off public links'), 'the note');
    expect(button('Anyone with the link')!.disabled).toBe(true);
  });

  it("answers a Bot's request to make it public through the same confirmation", async () => {
    server.sharing = sharing({
      pendingRequest: {
        approvalId: APPROVAL,
        visibility: 'public',
        version: 1,
        createdAt: '2026-11-19T10:00:00.000Z',
      },
    });
    render(<ShareControl artifactId={ID} title="Plan" />);
    await until(() => text().includes('Your Bot asks to make version 1 public'), 'the request');
    click('Approve');
    await until(() => !!button('Make version 1 public'), 'the dialog');
    expect(server.requests.some((r) => r.path.endsWith('/decide'))).toBe(false);
    click('Make version 1 public');
    await until(() => server.requests.some((r) => r.path.endsWith('/decide')), 'the decision');
    expect(server.requests.find((r) => r.path.endsWith('/decide'))!.body).toEqual({
      decision: 'approve',
    });
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
});
