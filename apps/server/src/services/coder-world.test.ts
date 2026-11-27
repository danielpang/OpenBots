import { CODERS_QUEUE } from '@openbots/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CoderJob } from './coder-jobs.js';
import { coderWorld, type CoderWorld } from './__fixtures__/coders/setup.js';

// The coders world's `process()` waits for the start's repository jobs that
// were queued, and only those: a queue that refused them leaves none to wait for.

describe('the coders test world', () => {
  let w: CoderWorld;
  beforeAll(async () => {
    w = await coderWorld('refused-jobs@example.com', { refuseRepoJobs: true });
  });
  afterAll(() => w.close());

  it('registers its processor at once when the start could not queue its repository jobs', async () => {
    const handled: string[] = [];
    await w.t.deps.infra
      .queue<CoderJob>(CODERS_QUEUE)
      .process(async (job) => void handled.push(job.data.kind));
    expect(handled).toEqual([]);
  });
});
