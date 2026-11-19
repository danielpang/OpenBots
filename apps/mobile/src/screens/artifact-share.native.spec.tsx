import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Alert, Linking } from 'react-native';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ArtifactShare, type ArtifactSharing } from './artifact-share';

const mockGet = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockPut = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockPost = jest.fn<(...args: unknown[]) => Promise<unknown>>();
jest.mock('../api/provider', () => ({
  useApi: () => ({ GET: mockGet, PUT: mockPut, POST: mockPost }),
}));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

const ID = 'art-1';
const ok = (data: unknown) => ({ data, response: { ok: true, status: 200 } });
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
let state: ArtifactSharing | null;
let alert: jest.SpiedFunction<typeof Alert.alert>;
/** The button the confirmation's person presses, by its text. */
let answer: string | null;
const caches: QueryClient[] = [];

beforeEach(() => {
  jest.clearAllMocks();
  state = sharing();
  answer = null;
  mockGet.mockImplementation(async () =>
    state ? ok(state) : { data: undefined, error: {}, response: { ok: false, status: 404 } },
  );
  mockPut.mockImplementation(async (_path, options) => {
    const body = (
      options as { body: { visibility: ArtifactSharing['visibility']; version?: number } }
    ).body;
    state = {
      ...state!,
      visibility: body.visibility,
      publicVersion: body.visibility === 'public' ? (body.version ?? null) : null,
    };
    return ok(state);
  });
  mockPost.mockImplementation(async (path) =>
    path === '/api/v1/artifacts/{id}/open'
      ? ok({ url: `${state!.url}?token=t`, expiresAt: null })
      : ok({ approval: {}, resumedRunId: null }),
  );
  alert = jest.spyOn(Alert, 'alert').mockImplementation((_title, _message, buttons) => {
    buttons?.find((b) => b.text === answer)?.onPress?.();
  });
});
afterEach(() => {
  cleanup();
  caches.forEach((cache) => cache.clear());
  caches.length = 0;
  alert.mockRestore();
});

function setup() {
  const cache = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { gcTime: Infinity },
    },
  });
  caches.push(cache);
  render(
    <QueryClientProvider client={cache}>
      <ArtifactShare id={ID} title="Plan" />
    </QueryClientProvider>,
  );
}

describe('Artifact sharing on the phone', () => {
  it('stays hidden on a server that does not host Artifacts', async () => {
    state = null;
    setup();
    await waitFor(() => expect(mockGet).toHaveBeenCalled());
    // Let the 404 settle before looking.
    await act(() => Promise.resolve());
    expect(screen.queryByText('Who can see it')).toBeNull();
  });

  it('shares with the organization in one step', async () => {
    setup();
    await waitFor(() => expect(screen.getByText('Nobody else can see it.')).toBeTruthy());
    fireEvent.press(screen.getByRole('button', { name: 'Your organization' }));
    await waitFor(() => expect(mockPut).toHaveBeenCalledTimes(1));
    expect((mockPut.mock.calls[0]![1] as { body: unknown }).body).toEqual({ visibility: 'org' });
    expect(await screen.findByRole('button', { name: 'Share link' })).toBeTruthy();
  });

  it('makes nothing public unless the person confirms who will see which version', async () => {
    setup();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Anyone with the link' })).toBeTruthy(),
    );
    answer = 'Cancel';
    fireEvent.press(screen.getByRole('button', { name: 'Anyone with the link' }));
    await waitFor(() => expect(alert).toHaveBeenCalledTimes(1));
    expect(alert.mock.calls[0]![0]).toBe('Make this public?');
    expect(alert.mock.calls[0]![1]).toContain(
      'Anyone with the link will be able to view version 2 of “Plan”, without signing in.',
    );
    expect(mockPut).not.toHaveBeenCalled();

    answer = 'Make version 2 public';
    fireEvent.press(screen.getByRole('button', { name: 'Anyone with the link' }));
    await waitFor(() => expect(mockPut).toHaveBeenCalledTimes(1));
    expect((mockPut.mock.calls[0]![1] as { body: unknown }).body).toEqual({
      visibility: 'public',
      version: 2,
      confirmed: true,
    });
  });

  it('keeps a newer version private until the person updates the public one', async () => {
    state = sharing({ visibility: 'public', publicVersion: 1, currentVersion: 3 });
    answer = 'Make version 3 public';
    setup();
    fireEvent.press(await screen.findByRole('button', { name: 'Update the public version' }));
    await waitFor(() => expect(mockPut).toHaveBeenCalledTimes(1));
    expect((mockPut.mock.calls[0]![1] as { body: unknown }).body).toEqual({
      visibility: 'public',
      version: 3,
      confirmed: true,
    });
  });

  it("answers a Bot's request to make it public through the same confirmation", async () => {
    state = sharing({
      pendingRequest: {
        approvalId: 'appr-1',
        visibility: 'public',
        version: 1,
        createdAt: '2026-11-19T10:00:00.000Z',
      },
    });
    answer = 'Cancel';
    setup();
    fireEvent.press(await screen.findByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(alert).toHaveBeenCalled());
    expect(mockPost).not.toHaveBeenCalled();
    answer = 'Make version 1 public';
    fireEvent.press(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));
    expect(mockPost.mock.calls[0]![0]).toBe('/api/v1/approvals/{id}/decide');
    expect((mockPost.mock.calls[0]![1] as { body: unknown }).body).toEqual({ decision: 'approve' });
  });

  it('opens it in the browser with a link the server mints', async () => {
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    setup();
    fireEvent.press(await screen.findByRole('button', { name: 'Open in browser' }));
    await waitFor(() => expect(open).toHaveBeenCalledWith(`${state!.url}?token=t`));
    open.mockRestore();
  });

  it('offers no public option when the organization turned public links off', async () => {
    state = sharing({ publicAllowed: false });
    setup();
    expect(await screen.findByText('Your organization has turned off public links.')).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Anyone with the link' }).props.accessibilityState
        ?.disabled,
    ).toBe(true);
  });
});
