import React from 'react';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { CloudSignInCancelled } from '../api/cloud-sign-in';
import { CloudSignInCard } from './onboarding';

// "Sign in to OpenBots Cloud" on the welcome screen (./onboarding.tsx), with
// the provider and Apple faked.

const mockSignIn = jest.fn<() => Promise<void>>();
const mockApple = jest.fn<() => Promise<void>>();
const mockReplace = jest.fn();
jest.mock('expo-camera', () => ({ CameraView: () => null, useCameraPermissions: () => [] }));
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: (...args: unknown[]) => mockReplace(...args) },
}));
jest.mock('../api/provider', () => ({
  CLOUD_URL: 'https://cloud.openbots.example',
  APPLE_SIGN_IN_BUILD: false,
  useMobile: () => ({ signInToCloud: mockSignIn, signInWithApple: mockApple }),
}));
jest.mock('../api/cloud-sign-in', () => ({ CloudSignInCancelled: class extends Error {} }));
jest.mock('expo-apple-authentication', () => ({ isAvailableAsync: async () => true }));
jest.mock('../hosts/pairing', () => ({ parsePairingLink: jest.fn() }));
jest.mock('../hosts/connection-qr', () => ({ parseConnectionQr: jest.fn() }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

beforeEach(() => {
  mockSignIn.mockReset().mockResolvedValue(undefined);
  mockApple.mockReset();
  mockReplace.mockReset();
});

describe('OpenBots Cloud sign-in', () => {
  it('signs in through the browser and opens the Bots', async () => {
    render(<CloudSignInCard />);
    fireEvent.press(screen.getByRole('button', { name: 'Sign in to OpenBots Cloud' }));
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/(tabs)/bots'));
    expect(mockSignIn).toHaveBeenCalledTimes(1);
  });

  it('says nothing when the person closes the browser', async () => {
    mockSignIn.mockRejectedValueOnce(new CloudSignInCancelled());
    render(<CloudSignInCard />);
    fireEvent.press(screen.getByRole('button', { name: 'Sign in to OpenBots Cloud' }));
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Sign in to OpenBots Cloud' }).props.accessibilityState
          .busy,
      ).toBe(false),
    );
    expect(mockSignIn).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Sign-in was cancelled.')).toBeNull();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('says why a sign-in failed', async () => {
    mockSignIn.mockRejectedValueOnce(new Error('This pairing code is not valid.'));
    render(<CloudSignInCard />);
    fireEvent.press(screen.getByRole('button', { name: 'Sign in to OpenBots Cloud' }));
    await waitFor(() => expect(screen.getByText('This pairing code is not valid.')).toBeTruthy());
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('offers no native Apple button in a build without the entitlement', () => {
    render(<CloudSignInCard />);
    expect(screen.queryByRole('button', { name: /Apple/ })).toBeNull();
  });
});
