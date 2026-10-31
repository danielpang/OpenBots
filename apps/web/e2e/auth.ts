import { expect, type Page } from '@playwright/test';

export const PASSWORD = 'correct horse battery';

/**
 * Signs a new user up and lands on the shell. A fresh instance has no users,
 * so its sign-up page redirects to the first-run wizard (D1): the first user
 * is created there, as the owner (an admin internally), and the wizard's
 * remaining steps are skipped. When tests run in parallel, another may create
 * the owner first; then the setup route answers 409 and this falls back to a
 * normal sign-up. That needs the managed service (OPENBOT_DEPLOYMENT=managed,
 * as CI runs it): a self-hosted install closes sign-up after its owner.
 */
export async function signUp(page: Page, name: string, email: string): Promise<void> {
  const setup = (await (await page.request.get('/api/v1/setup')).json()) as {
    setupRequired: boolean;
  };
  if (setup.setupRequired && (await createOwner(page, name, email))) {
    await page.goto('/');
  } else {
    await page.goto('/sign-up');
    await fillAccount(page, name, email);
    await submitSignUp(page);
  }
  await expect(page).toHaveURL('/');
}

/** Attempts at Sign up while the limit refuses it; each waits out the server's X-Retry-After. */
const SIGN_UP_ATTEMPTS = 4;

/**
 * Clicks Sign up. Every spec signs up from the same address, and sign-up is
 * rate limited per address (better-auth's 3 per 10 s, kept on in CI), so
 * specs in one run can find the limit spent. Then the server answers 429
 * with X-Retry-After in seconds; this waits that long and clicks again.
 */
async function submitSignUp(page: Page) {
  for (let attempt = 1; ; attempt++) {
    const [res] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().endsWith('/api/auth/sign-up/email') && r.request().method() === 'POST',
      ),
      page.getByRole('button', { name: 'Sign up' }).click(),
    ]);
    if (res.status() !== 429) return;
    expect(attempt, 'sign-up stayed rate limited').toBeLessThan(SIGN_UP_ATTEMPTS);
    const seconds = Number(res.headers()['x-retry-after']) || 10;
    await page.waitForTimeout(seconds * 1000 + 250);
  }
}

async function createOwner(page: Page, name: string, email: string): Promise<boolean> {
  await page.goto('/setup');
  await fillAccount(page, name, email);
  const [res] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().endsWith('/api/v1/setup/admin') && r.request().method() === 'POST',
    ),
    page.getByRole('button', { name: 'Create account' }).click(),
  ]);
  if (res.ok()) return true;
  expect(res.status(), 'only losing the race to another test is expected').toBe(409);
  return false;
}

async function fillAccount(page: Page, name: string, email: string) {
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
}
