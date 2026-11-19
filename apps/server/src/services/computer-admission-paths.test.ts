import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '../db/client.js';
import type { ComputerWorkRefusal, ComputerWorkRequest, ServerExtensions } from '../extensions.js';
import { coderWorld, defaultGit, REPO_PATH, type CoderWorld } from './__fixtures__/coders/setup.js';
import { stageCodingAttachments } from './coding-attachments.js';
import { getComputer, startComputer, stopComputer } from './computer.js';
import { storeFile } from './files.js';
import { resolveConnectedModel } from './model-connections.js';
import { createProvider } from './providers.js';
import { ensureCheckout } from './repos-checkout.js';
import { rescueRepos, runRescueJob } from './repos-rescue.js';

// The repository paths that start a member's computer ask the managed build
// first (computer-admission.ts): a checkout the owner asked for and a rescue
// are refused with the plan's words and code and start nothing, a computer
// already running is not asked, and a reset whose rescue was refused keeps
// everything. Coding-agent sign-in, model connections and coding
// attachments are left open on purpose, so a member at a limit can still fix
// their setup.

describe('computer admission on the repository paths', () => {
  let w: CoderWorld;
  let computerId: string;
  const asked: ComputerWorkRequest[] = [];
  let answer: (request: ComputerWorkRequest) => ComputerWorkRefusal | null = () => null;
  const refusal: ComputerWorkRefusal = {
    code: 'PLAN_ALLOWANCE_REACHED',
    message:
      'This organization has used the 100 computer hours its plan includes this period. An owner or admin can allow overage under Settings, Billing.',
  };

  beforeAll(async () => {
    w = await coderWorld('admission-paths@example.com');
    const extensions: ServerExtensions = {
      admitComputerWork: (request) => {
        asked.push(request);
        return answer(request);
      },
    };
    // The test app's deps are the ones every route and job here reads.
    (w.t.deps as { extensions?: ServerExtensions }).extensions = extensions;
    const [computer] = await w.t.db
      .select()
      .from(schema.computers)
      .where(eq(schema.computers.ownerId, w.ownerId));
    computerId = computer!.id;
  });
  afterAll(() => w.close());
  beforeEach(() => {
    asked.length = 0;
    answer = () => null;
    w.coder.git = defaultGit;
    w.coder.agent = (io) => io.exit(0);
  });

  const owner = () => ({ id: w.ownerId, workspaceId: w.workspaceId });
  const status = async () =>
    (await w.t.db.select().from(schema.computers).where(eq(schema.computers.id, computerId)))[0]!
      .status;
  async function stopped() {
    const row = await w.t.inOrganization(() => getComputer(w.t.deps, owner()));
    if (row && row.status !== 'stopped') {
      await w.t.inOrganization(() => stopComputer(w.t.deps, row));
    }
    expect(await status()).toBe('stopped');
  }
  async function running() {
    await w.t.inOrganization(() => startComputer(w.t.deps, owner()));
    expect(await status()).toBe('running');
  }
  async function checkoutRow(state: string) {
    await w.t.db
      .delete(schema.repoCheckouts)
      .where(eq(schema.repoCheckouts.computerId, computerId));
    await w.t.db.insert(schema.repoCheckouts).values({
      workspaceId: w.workspaceId,
      repoId: w.repoId,
      computerId,
      path: REPO_PATH,
      state,
    });
  }
  const checkout = async () =>
    (
      await w.t.db
        .select()
        .from(schema.repoCheckouts)
        .where(
          and(
            eq(schema.repoCheckouts.repoId, w.repoId),
            eq(schema.repoCheckouts.computerId, computerId),
          ),
        )
    )[0]!;

  describe('a checkout', () => {
    it('refused: fails with the reason and the code, and the computer stays off', async () => {
      await stopped();
      await checkoutRow('cloning');
      answer = () => refusal;
      const before = w.coder.calls.length;
      await expect(
        w.t.inOrganization(() => ensureCheckout(w.t.deps, w.repoId, computerId, 'clone')),
      ).rejects.toMatchObject({ status: 402, code: refusal.code, message: refusal.message });
      expect(await checkout()).toMatchObject({ state: 'error', error: refusal.message });
      expect(await status()).toBe('stopped');
      expect(w.coder.calls.length).toBe(before);
      expect(asked).toEqual([
        { workspaceId: w.workspaceId, ownerId: w.ownerId, kind: 'repository' },
      ]);
    });

    it('admitted: starts the computer and clones', async () => {
      await stopped();
      await checkoutRow('cloning');
      const done = await w.t.inOrganization(() =>
        ensureCheckout(w.t.deps, w.repoId, computerId, 'clone'),
      );
      expect(done.state).not.toBe('error');
      expect(await status()).toBe('running');
      expect(asked.map((r) => r.kind)).toEqual(['repository']);
    });

    it('on a computer already running: not asked, and the work goes on', async () => {
      await running();
      await checkoutRow('cloning');
      answer = () => refusal;
      const done = await w.t.inOrganization(() =>
        ensureCheckout(w.t.deps, w.repoId, computerId, 'clone'),
      );
      expect(done.state).not.toBe('error');
      expect(asked).toEqual([]);
    });
  });

  describe('a rescue', () => {
    it('refused: saves nothing, says why with the code, and the computer stays off', async () => {
      await stopped();
      await checkoutRow('ready');
      answer = () => refusal;
      const before = w.coder.calls.length;
      await expect(
        w.t.inOrganization(() => rescueRepos(w.t.deps, w.ownerId, computerId)),
      ).rejects.toMatchObject({ status: 402, code: refusal.code, message: refusal.message });
      expect(await status()).toBe('stopped');
      expect(w.coder.calls.length).toBe(before);
      expect(asked.map((r) => r.kind)).toEqual(['repository']);
    });

    it('admitted: starts the computer and rescues', async () => {
      await stopped();
      await checkoutRow('ready');
      const results = await w.t.inOrganization(() => rescueRepos(w.t.deps, w.ownerId, computerId));
      expect(results.length).toBeGreaterThan(0);
      expect(await status()).toBe('running');
      expect(asked.map((r) => r.kind)).toEqual(['repository']);
    });

    it('on a computer already running: not asked, and the rescue runs', async () => {
      await running();
      await checkoutRow('ready');
      answer = () => refusal;
      const results = await w.t.inOrganization(() => rescueRepos(w.t.deps, w.ownerId, computerId));
      expect(results.length).toBeGreaterThan(0);
      expect(asked).toEqual([]);
    });
  });

  describe('a reset whose rescue was refused', () => {
    type ResetStatus = { status: string; error: string | null; errorCode: string | null };

    async function prepared() {
      const res = await w.call('POST', '/computer/reset/prepare');
      expect(res.status, await res.clone().text()).toBe(202);
      const { requestId } = (await res.json()) as { requestId: string };
      await w.t.inOrganization(() =>
        runRescueJob(w.t.deps, { ownerId: w.ownerId, computerId, requestId }),
      );
      const status = await w.until(async () => {
        const body = (await (
          await w.call('GET', `/computer/reset/${requestId}`)
        ).json()) as ResetStatus;
        expect(body.status).toBe('done');
        return body;
      });
      return { requestId, status };
    }

    it('keeps the computer and its home, says why, and resets once a rescue can run', async () => {
      await stopped();
      await checkoutRow('ready');
      answer = () => refusal;
      const { requestId, status: check } = await prepared();
      expect(check).toMatchObject({ error: refusal.message, errorCode: refusal.code });
      const res = await w.call('POST', '/computer/reset', { requestId, confirm: true });
      expect(res.status).toBe(402);
      expect(await res.json()).toMatchObject({
        code: refusal.code,
        title: `Unpushed work could not be checked, so the computer was not reset. ${refusal.message}`,
      });
      // Nothing was removed: the machine, its checkouts and no reset audited.
      expect(await status()).toBe('stopped');
      expect((await checkout()).state).toBe('ready');
      expect(
        await w.t.db
          .select()
          .from(schema.auditLog)
          .where(eq(schema.auditLog.action, 'computer.reset')),
      ).toEqual([]);

      // Once the organization may start the computer, a new check rescues, then resets.
      answer = () => null;
      const again = await prepared();
      expect(again.status).toMatchObject({ error: null, errorCode: null });
      const reset = await w.call('POST', '/computer/reset', {
        requestId: again.requestId,
        confirm: true,
      });
      expect(reset.status, await reset.clone().text()).toBe(202);
      expect((await checkout()).state).toBe('missing');
    });
  });

  it('leaves coding-agent sign-in, model connections and coding attachments open', async () => {
    answer = () => refusal;

    // Sign-in: the check runs the CLI on the computer, starting it.
    await stopped();
    w.coder.agent = (io) => {
      const { command, args = [] } = io.call.launch;
      if (command === 'claude' && args.join(' ') === 'auth status') {
        io.stdout(`${JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' })}\n`);
      }
      io.exit(0);
    };
    const check = await w.call('POST', '/coders/claude/check');
    expect(check.status, await check.clone().text()).toBe(200);
    expect(await status()).toBe('running');

    // A model connection through the subscription the check just recorded.
    await stopped();
    const { row } = await w.t.inOrganization(() =>
      createProvider(w.t.ownerDeps, owner(), { presetId: 'anthropic' }),
    );
    const resolved = await w.t.inOrganization(() =>
      resolveConnectedModel(
        w.t.ownerDeps,
        { provider_id: row.id, model_id: 'claude-opus-5-5' },
        owner(),
      ),
    );
    expect(typeof resolved.model).not.toBe('string');
    const model = resolved.model as Exclude<typeof resolved.model, string>;
    await w.t
      .inOrganization(async () => {
        const { stream } = await model.doStream({
          prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
          abortSignal: AbortSignal.timeout(5_000),
        });
        for await (const part of stream) void part;
      })
      // What the scripted CLI answers does not matter here, only that it ran.
      .catch(() => {});
    expect(await status()).toBe('running');

    // Coding attachments staged on the computer for a session.
    await stopped();
    const file = await w.t.inOrganization(() =>
      storeFile(w.t.ownerDeps, owner(), {
        name: 'notes.txt',
        bytes: Buffer.from('reference text'),
        declaredMime: 'text/plain',
        purpose: 'attachment',
      }),
    );
    const staged = await w.t.inOrganization(() =>
      stageCodingAttachments(w.t.deps, owner(), [file.id]),
    );
    expect(staged.context).toContain('notes.txt');
    expect(await status()).toBe('running');
    await staged.cleanup();

    // None of the three asked.
    expect(asked).toEqual([]);
  });
});
