import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp } from './test-app.js';

// The suites that store and read files the most, run a second time with
// every test app on the S3 driver and its in-process stand-in
// (OPENBOTS_TEST_STORAGE=s3, test-app.ts), as part of the normal `test`
// run, so CI covers the s3 driver end to end without a job of its own. The
// whole suite in that mode is `pnpm --filter @openbots/server test:s3`
// (docs/CONTRIBUTING.md says when to run it).
//
// The setting is read when a test app is made, in each suite's beforeAll,
// so it is set before the suites are loaded and put back after they end:
// files that share this worker run one after another, and none sees it.

const previous = process.env.OPENBOTS_TEST_STORAGE;
process.env.OPENBOTS_TEST_STORAGE = 's3';
afterAll(() => {
  if (previous === undefined) delete process.env.OPENBOTS_TEST_STORAGE;
  else process.env.OPENBOTS_TEST_STORAGE = previous;
});

describe('S3 mode', () => {
  let storage: string | undefined;
  beforeAll(async () => {
    const t = await createTestApp();
    storage = t.storage;
    await t.close();
  });
  it('makes test apps on the s3 driver', () => {
    expect(storage).toBe('s3');
  });
});

await import('./routes/artifacts.test.js');
await import('./routes/avatars.test.js');
await import('./routes/artifact-sharing.test.js');
await import('./workers/attachments.test.js');
