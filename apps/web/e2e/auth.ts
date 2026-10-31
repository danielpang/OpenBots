import { readFileSync } from 'node:fs';
import { expect, type Page } from '@playwright/test';

export const PASSWORD = 'correct horse battery';

/**
 * Signs a new user up and lands on the shell. A fresh self-hosted install has
 * no users, so its sign-up page redirects to the first-run wizard (D1): the
 * first user is created there, as the owner, and the wizard's remaining
 * steps are skipped.
 *
 * The managed service (its server from ee/server, as CI runs it) has no
 * wizard: the account verifies its email (see `verificationLink`), then
 * creates its organization, named `organization` or after the person, and
 * owns it. `signUpAt` does the same from an invite link instead.
 */
export async function signUp(
  page: Page,
  name: string,
  email: string,
  { organization }: { organization?: string } = {},
): Promise<void> {
  const setup = (await (await page.request.get('/api/v1/setup')).json()) as {
    setupRequired: boolean;
  };
  if (setup.setupRequired && (await createOwner(page, name, email))) {
    await page.goto('/');
  } else {
    await signUpAt(page, '/sign-up', name, email);
    if (new URL(page.url()).pathname === '/onboarding') {
      await page.getByLabel('Name').fill(organization ?? `${name} Org`);
      await page.getByRole('button', { name: 'Create' }).click();
    }
  }
  await expect(page).toHaveURL('/');
}

/**
 * Signs up at `path` (/sign-up, or an invite link), verifying the email when
 * the server asks for it, and returns once the page has moved on.
 */
export async function signUpAt(page: Page, path: string, name: string, email: string) {
  const seen = logLines().length;
  await page.goto(path);
  await fillAccount(page, name, email);
  await submitSignUp(page);
  const checkEmail = page.getByText('Check your email');
  await expect(checkEmail.or(page.getByRole('button', { name: /New|Join|Create/ }))).toBeVisible();
  if (await checkEmail.isVisible()) await page.goto(await verificationLink(seen));
}

/** The server's log (E2E_SERVER_LOG), one JSON line each, or none. */
function logLines(): string[] {
  const file = process.env.E2E_SERVER_LOG;
  if (!file) return [];
  try {
    return readFileSync(file, 'utf8').split('\n');
  } catch {
    return [];
  }
}

/**
 * The newest email verification link in the server's log after line `after`.
 * CI runs the managed server without email and with
 * OPENBOT_DEV_LOG_EMAIL_LINKS=1, which logs the link instead of sending it.
 */
export async function verificationLink(after: number): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const url = logLines()
      .slice(after)
      .map((line) => {
        try {
          return JSON.parse(line) as { msg?: string; url?: string };
        } catch {
          return {};
        }
      })
      .filter((entry) => entry.msg === 'email verification link' && entry.url)
      .at(-1)?.url;
    if (url) return url;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('no email verification link in E2E_SERVER_LOG');
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
