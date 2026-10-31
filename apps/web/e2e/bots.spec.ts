import { expect, test, type Page } from '@playwright/test';
import { signUp } from './auth.js';

test.skip(!process.env.E2E, 'set E2E=1 to run against the dev server');

const signUpRoster = (page: Page) =>
  signUp(page, 'Roster', `roster-${Date.now()}-${Math.random()}@example.com`);

const roster = (page: Page) => page.getByRole('navigation');

test('type a name and start', async ({ page }) => {
  await signUpRoster(page);
  await page.getByRole('button', { name: /New/ }).click();
  await page.getByLabel('Bot name').fill('Finance');
  await page.getByRole('button', { name: 'Start' }).click();

  await expect(page).toHaveURL(/\/bots\/[0-9a-f-]+$/);
  await expect(page.getByRole('heading', { name: 'Finance' })).toBeVisible();
  await expect(roster(page).getByRole('link', { name: /Finance/ })).toBeVisible();
});

test('create a Bot step by step', async ({ page }) => {
  await signUpRoster(page);
  await page.getByRole('button', { name: /New/ }).click();
  await page.getByRole('button', { name: 'Create new Bot' }).click();
  await page.getByLabel('Name').fill('Support triage');
  await page.getByRole('button', { name: 'Next' }).click();
  await page
    .getByRole('textbox', { name: 'Goal or area of ownership' })
    .fill('Keep the support inbox triaged');
  for (let step = 0; step < 3; step++) await page.getByRole('button', { name: 'Next' }).click();
  await page
    .getByRole('textbox', { name: 'Approval boundary' })
    .fill('Ask before replying to a customer');
  // The last step, an optional recurring schedule (B2), is left off.
  await page.getByRole('button', { name: 'Next' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Recurring schedule' })).toBeVisible();
  await expect(dialog.getByRole('checkbox', { name: 'Run on a schedule' })).not.toBeChecked();
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();

  await expect(page).toHaveURL(/\/bots\/[0-9a-f-]+$/);
  await expect(roster(page).getByRole('link', { name: /Support triage/ })).toBeVisible();
  await page.getByRole('tab', { name: 'Settings' }).click();
  await expect(page.getByRole('textbox', { name: /^Description/ })).toHaveValue(
    'Goal: Keep the support inbox triaged\nAsk first: Ask before replying to a customer',
  );
});
