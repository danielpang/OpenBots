import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ComputerWorkRefusal, ComputerWorkRequest } from '../extensions.js';
import { createTestApp, type TestApp } from '../test-app.js';
import { useTestComputer, type TestComputer } from '../test-computer.js';
import {
  computerServices,
  computerUseScope,
  getComputer,
  stopComputer,
  wakeComputer,
} from './computer.js';
import { shortReason } from './computer-admission.js';
import { settleComputerUses } from './computer-use.js';

// New computer work asks the managed build first (computer-admission.ts):
// the member's start, restart and wake answer 402 with the refusal's code, a
// run's first computer call fails with it (the Bot reads the words), a
// message does not wake a computer that would be refused, and work already
// under way goes on: a run's later calls are asked only with
// `continuingSince`. With no extension (self-hosted) nothing changes, and a
// failing extension admits.

describe('computer work admission', () => {
  let t: TestApp;
  let computer: TestComputer;
  let cookie: string;
  let owner: { id: string; workspaceId: string };
  const asked: ComputerWorkRequest[] = [];
  let answer: (request: ComputerWorkRequest) => ComputerWorkRefusal | null = () => null;

  const refusal: ComputerWorkRefusal = {
    code: 'PLAN_ALLOWANCE_REACHED',
    message:
      'Your organization has used the 100 computer hours its plan includes this period. An owner or admin can allow overage under Settings, Billing.',
  };

  beforeAll(async () => {
    t = await createTestApp(
      {},
      {
        extensions: {
          admitComputerWork: (request) => {
            asked.push(request);
            return answer(request);
          },
        },
      },
    );
    computer = await useTestComputer(t.ownerDeps);
    cookie = (await t.signUp('admit@example.com')).cookie!;
    owner = { id: await t.userId('admit@example.com'), workspaceId: await t.defaultOrganization() };
  });
  afterAll(async () => {
    await computer.close();
    await t.close();
  });
  beforeEach(() => {
    asked.length = 0;
    answer = () => null;
  });

  const post = (path: string) =>
    t.app.request(`/api/v1${path}`, { method: 'POST', headers: { cookie } });

  async function stopped() {
    const row = await t.inOrganization(() => getComputer(t.deps, owner));
    if (row && row.status !== 'stopped') await t.inOrganization(() => stopComputer(t.deps, row));
  }

  it('refuses the member’s start, restart and wake with 402 and the code, starting nothing', async () => {
    answer = () => refusal;
    for (const path of ['/computer/start', '/computer/wake']) {
      const res = await post(path);
      expect(res.status).toBe(402);
      expect(await res.json()).toMatchObject({ code: refusal.code, title: refusal.message });
    }
    expect(computer.docker.calls.some((c) => c.op === 'createContainer')).toBe(false);
    expect(asked.every((r) => r.kind === 'manual' && r.ownerId === owner.id)).toBe(true);

    answer = () => null;
    expect((await post('/computer/start')).status).toBe(200);
    answer = () => refusal;
    expect((await post('/computer/restart')).status).toBe(402);
    // Refused, not stopped: the computer stays as it was.
    expect((await t.inOrganization(() => getComputer(t.deps, owner)))?.status).toBe('running');
  });

  it('keeps a code the core can render: anything else becomes COMPUTER_WORK_REFUSED', async () => {
    answer = () => ({ code: 'not a code', message: 'No.' });
    const res = await post('/computer/start');
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ code: 'COMPUTER_WORK_REFUSED', title: 'No.' });
  });

  it('does not let a message wake a computer that would be refused, and says so', async () => {
    await stopped();
    answer = () => refusal;
    expect(await t.inOrganization(() => wakeComputer(t.deps, owner, { touch: true }))).toBe(
      'refused',
    );
    expect((await t.inOrganization(() => getComputer(t.deps, owner)))?.status).toBe('stopped');
  });

  it("refuses a run's first computer call, and asks its later calls only with continuingSince", async () => {
    const use = computerUseScope(t.deps, 'run');
    const services = computerServices(t.deps, {
      bot: { id: crypto.randomUUID(), ownerId: owner.id, workspaceId: owner.workspaceId },
      runId: crypto.randomUUID(),
      recordStep: async () => {},
      use,
    });
    answer = () => refusal;
    await expect(t.inOrganization(() => services.agent())).rejects.toMatchObject({
      status: 402,
      code: refusal.code,
      message: refusal.message,
    });
    expect(asked.at(-1)).toMatchObject({ kind: 'run' });
    expect(asked.at(-1)?.continuingSince).toBeUndefined();

    // Admitted, the run's work begins; from then on the organization's
    // limits do not stop it. Only a refusal about the run itself would.
    answer = () => null;
    await t.inOrganization(() => services.agent());
    answer = (request) => (request.continuingSince ? null : refusal);
    await t.inOrganization(() => services.agent());
    expect(asked.at(-1)?.continuingSince).toBeInstanceOf(Date);
    await use.end();
    await settleComputerUses();
  });

  it('admits when the extension fails, as with no extension', async () => {
    answer = () => {
      throw new Error('billing database unreachable');
    };
    expect((await post('/computer/start')).status).toBe(200);
  });

  it('cuts a refusal to its first sentence for a socket close reason', () => {
    expect(shortReason(refusal.message)).toBe(
      'Your organization has used the 100 computer hours its plan includes this period.',
    );
    const long = `${'word '.repeat(60)}end.`;
    expect(Buffer.byteLength(shortReason(long))).toBeLessThanOrEqual(123);
    expect(shortReason(long).endsWith('…')).toBe(true);
  });
});

describe('computer work admission on a self-hosted server', () => {
  it('admits everything without an extension', async () => {
    const t = await createTestApp();
    const computer = await useTestComputer(t.ownerDeps);
    try {
      const { cookie } = await t.signUp('solo@example.com');
      const res = await t.app.request('/api/v1/computer/start', {
        method: 'POST',
        headers: { cookie: cookie! },
      });
      expect(res.status).toBe(200);
    } finally {
      await computer.close();
      await t.close();
    }
  });
});
