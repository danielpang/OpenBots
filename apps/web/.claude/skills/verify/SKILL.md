---
name: verify
description: Verify a change to the OpenBots web app (apps/web, ee/web, packages/ui, packages/widgets) in a real browser against a running server. Use before committing any change a person would see in the web app, and when asked to check, screenshot or smoke test the UI.
---

# Verify a web change in the browser

## Boot

```sh
bash scripts/verify-stack.sh start --managed   # from the repository root
eval "$(bash scripts/verify-stack.sh env)"     # E2E, E2E_BASE_URL, E2E_SERVER_LOG
```

Use `--managed` unless the change is about the self-hosted first-run wizard: most specs sign up several users, and a self-hosted install closes sign-up after its owner. The managed stack serves `ee/web`, which wraps `apps/web`.

Playwright needs a Chromium. `pnpm --filter @openbots/web exec playwright install chromium` gets the pinned one. Where that cannot be downloaded (a cloud container), point at one that is there: `export E2E_CHROMIUM_PATH=/opt/pw-browsers/chromium`.

## Run the specs for the flow you changed

```sh
cd apps/web
pnpm exec playwright test e2e/<spec>.spec.ts --workers=1 --trace off
```

| You changed                             | Spec                                              |
| --------------------------------------- | ------------------------------------------------- |
| sign-up, the shell, navigation          | `smoke.spec.ts`                                   |
| creating or editing a Bot               | `bots.spec.ts`                                    |
| messages, streaming, threads, reactions | `transcript.spec.ts`                              |
| tool calls, approvals, widgets          | `tools.spec.ts`                                   |
| groups, mentions, Bot to Bot            | `groups.spec.ts`                                  |
| Routines                                | `routines.spec.ts`                                |
| Artifacts                               | `artifacts.spec.ts`                               |
| organizations, invites, roles           | `organizations.spec.ts` (managed only)            |
| the first-run wizard                    | `self-hosted.spec.ts` (start without `--managed`) |

Keep `--workers=1`: the specs share one server and its sign-up rate limits. A Bot's replies come from the scripted model in `e2e/fake-model.ts`, so no provider key is needed.

## Look at what you changed

A spec passing shows the old flows still work. It does not show your change. Write a scratch spec that walks to it and takes a screenshot, then read the screenshot:

```ts
// apps/web/e2e/mine.scratch.spec.ts (git ignores *.scratch.spec.ts)
import { expect, test } from '@playwright/test';
import { signUp } from './auth.js';

test('my change', async ({ page }) => {
  await signUp(page, 'Verify', `verify-${Date.now()}@example.com`);
  // ...walk to what you changed, as a person would...
  await expect(page.getByRole('button', { name: /New/ })).toBeVisible();
  await page.screenshot({ path: 'test-results/mine.png', fullPage: true });
});
```

Check, for the screens you touched: the empty state, a long name or message, a narrow window (`page.setViewportSize({ width: 390, height: 844 })`), and dark mode (`page.emulateMedia({ colorScheme: 'dark' })`) when you changed styling. Look at the browser console too: `page.on('console', ...)` should show no new errors.

If the flow you changed has no spec and will matter again, turn the scratch spec into a real one in the same pull request.

## When something fails

`.verify/server.log` has the server's side, including the sign-up codes the specs read. `apps/web/test-results/` has Playwright's error context. Run one failing test again with `--trace on` to step through it.

## Finish

```sh
bash scripts/verify-stack.sh stop
```

Stamp the commit `Verified: verify` when you drove your own change, `Verified: e2e` when you ran its specs only.
