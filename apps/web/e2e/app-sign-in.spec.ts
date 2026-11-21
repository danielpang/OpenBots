import { createHash, randomBytes } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { PASSWORD, signUp } from './auth.js';

// The iOS or Mac app signing in through the browser (server:
// services/app-sign-in.ts; web: routes/app-sign-in.tsx). The app opens
// /app-sign-in with its PKCE challenge; signed out, the person signs in first
// and comes back to it; once they confirm, the browser is sent back into the
// app with a one-time code, which only the app's verifier turns into a
// session. The custom scheme goes nowhere in a test browser, so the spec
// reads the code from the page's own request and trades it as the Mac app does.

test.skip(!process.env.E2E, 'set E2E=1 to run against the dev server');

const stamp = Date.now();
const EMAIL = `app-${stamp}@example.com`;

function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

test('signs the Mac app in from the browser, after signing in there first', async ({
  browser,
  page,
}) => {
  test.setTimeout(90_000);
  await signUp(page, 'App Person', EMAIL);

  // The Mac app opens a fresh browser, signed out.
  const context = await browser.newContext();
  const fresh = await context.newPage();
  const { verifier, challenge } = pkce();
  const state = randomBytes(16).toString('base64url');
  await fresh.goto(`/app-sign-in?platform=desktop&challenge=${challenge}&state=${state}`);
  await expect(fresh).toHaveURL(/\/sign-in/);
  await fresh.getByLabel('Email').fill(EMAIL);
  await fresh.getByLabel('Password').fill(PASSWORD);
  await fresh.getByRole('button', { name: 'Sign in', exact: true }).click();

  // Back to the request, which names the account and the app.
  await expect(fresh.getByRole('heading', { name: 'Sign in to the app' })).toBeVisible();
  await expect(fresh.getByText('the OpenBots app on your Mac')).toBeVisible();
  await fresh.screenshot({ path: 'test-results/app-sign-in.png', fullPage: true });

  const [codeResponse] = await Promise.all([
    fresh.waitForResponse(
      (r) => r.url().endsWith('/api/v1/app-sign-in/codes') && r.request().method() === 'POST',
    ),
    fresh.getByRole('button', { name: 'Continue' }).click(),
  ]);
  expect(codeResponse.status()).toBe(201);
  const { code } = (await codeResponse.json()) as { code: string };

  // Without the verifier the code is nothing; with it, the Mac has a session.
  const stolen = await context.request.post('/api/v1/app-sign-in/session', {
    data: { code, codeVerifier: pkce().verifier, name: 'Not the Mac' },
  });
  expect(stolen.status()).toBe(401);
  const mac = await browser.newContext();
  const traded = await mac.request.post('/api/v1/app-sign-in/session', {
    data: { code, codeVerifier: verifier, name: 'E2E Mac' },
  });
  expect(traded.status()).toBe(200);
  const me = await mac.request.get('/api/v1/me');
  expect(((await me.json()) as { user: { email: string } }).user.email).toBe(EMAIL);

  // The Mac shows in Settings > Devices, and revoking it signs it out.
  await page.goto('/settings/devices');
  await expect(page.getByText('E2E Mac')).toBeVisible();
  const devices = (await (await page.request.get('/api/v1/devices')).json()) as {
    items: { id: string; name: string }[];
  };
  const device = devices.items.find((d) => d.name === 'E2E Mac')!;
  const revoked = await page.request.delete(`/api/v1/devices/${device.id}`);
  expect(revoked.status()).toBe(204);
  expect((await mac.request.get('/api/v1/me')).status()).toBe(401);

  await context.close();
  await mac.close();
});

test('an incomplete link asks to start again from the app', async ({ page }) => {
  await page.goto('/app-sign-in?platform=desktop');
  await expect(page.getByRole('heading', { name: 'Open the app again' })).toBeVisible();
});
