// @vitest-environment happy-dom
import { Dialog } from '@openbot/ui';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { capabilitiesQuery, meQuery } from '../../app/api.js';
import { me } from '../../test-utils.js';
import type { Template } from './api.js';
import { FromTemplate } from './template-list.js';

// A template's visibility in "Create from template" against a fake REST
// server (B6, U3): its owner makes it public while the admin allows public
// links, and workspace-only again at any time; other members get no control.

const ME = me('member').user;

const server = vi.hoisted(() => {
  const state = {
    realFetch: globalThis.fetch,
    items: [] as Template[],
    publicEnabled: false,
    patches: [] as { token: string; body: unknown }[],
  };
  // The api client keeps the fetch it was created with, so swap it before any import.
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const { pathname } = new URL(request.url, 'http://localhost');
    if (pathname === '/api/v1/templates' && request.method === 'GET') {
      return Response.json({ items: state.items, publicEnabled: state.publicEnabled });
    }
    const token = pathname.match(/^\/api\/v1\/templates\/([^/]+)$/)?.[1];
    const template = state.items.find((t) => t.token === token);
    if (template && request.method === 'PATCH') {
      const body = (await request.json()) as { visibility: Template['visibility'] };
      state.patches.push({ token: token!, body });
      template.visibility = body.visibility;
      return Response.json(template);
    }
    return Response.json({ title: 'Not found' }, { status: 404 });
  };
  return state;
});
afterAll(() => {
  globalThis.fetch = server.realFetch;
});

const template = (n: number, fields: Partial<Template>): Template => ({
  id: `00000000-0000-4000-8000-00000000001${n}`,
  name: `Template ${n}`,
  visibility: 'workspace',
  token: `tok_${n}`,
  owner: { id: ME.id, name: ME.name },
  botName: 'Analyst',
  skills: 0,
  routines: 0,
  createdAt: '2026-10-20T00:00:00.000Z',
  ...fields,
});

beforeEach(() => {
  server.patches = [];
  server.publicEnabled = true;
  server.items = [
    template(1, { name: 'Mine, shared' }),
    template(2, { name: 'Mine, public', visibility: 'public' }),
    template(3, {
      name: "Grace's",
      owner: { id: '00000000-0000-4000-8000-000000000099', name: 'Grace' },
    }),
  ];
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLElement;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
});

async function render() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(meQuery.queryKey, me('member') as never);
  // The managed service's wording; deployment.test.tsx covers self-hosted.
  queryClient.setQueryData(capabilitiesQuery.queryKey, {
    oauth: { github: false, google: false },
    deployment: 'managed',
  });
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => (
        <Dialog open>
          <FromTemplate onBack={() => {}} onDone={() => {}} />
        </Dialog>
      ),
    }),
    history: createMemoryHistory(),
  });
  await router.load();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    ),
  );
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

/** The visibility button on the row of the template named `name`, if any. */
const control = (name: string) => {
  const row = [...document.querySelectorAll('li')].find((li) => li.textContent?.includes(name));
  return [...(row?.querySelectorAll('button') ?? [])].find((b) =>
    /^Make (public|workspace only)$/.test(b.textContent ?? ''),
  );
};

describe('template visibility', () => {
  it("lets the owner switch a template's visibility, and no one else", async () => {
    await render();
    await until(() => !!control('Mine, shared'), 'the list');
    expect(control('Mine, shared')!.textContent).toBe('Make public');
    expect(control('Mine, public')!.textContent).toBe('Make workspace only');
    expect(control("Grace's")).toBeUndefined();

    act(() => control('Mine, shared')!.click());
    await until(() => control('Mine, shared')?.textContent === 'Make workspace only', 'public');
    act(() => control('Mine, public')!.click());
    await until(() => control('Mine, public')?.textContent === 'Make public', 'workspace');
    expect(server.patches).toEqual([
      { token: 'tok_1', body: { visibility: 'public' } },
      { token: 'tok_2', body: { visibility: 'workspace' } },
    ]);
  });

  it('only closes public links while the admin has them off', async () => {
    server.publicEnabled = false;
    await render();
    await until(() => !!control('Mine, shared'), 'the list');
    const makePublic = control('Mine, shared')!;
    expect(makePublic.disabled).toBe(true);
    expect(makePublic.title).toBe('An admin has public links off');
    expect(control('Mine, public')!.disabled).toBe(false);
  });
});
