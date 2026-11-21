import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, storageWarning } from '../config.js';
import { schema } from '../db/client.js';
import { generateMasterKey } from '../secrets.js';
import {
  callToolForBot,
  closeMcpManager,
  createConnector,
  listToolsForBot,
  stdioSpawnFor,
} from '../services/connectors.js';
import { botToolDefaults } from '../services/policy.js';
import { createTestApp, type TestApp } from '../test-app.js';

// Folder (filesystem) connectors. Where stdio connectors run in the
// member's own computer (OPENBOTS_STDIO_RUNNER=computer, the managed
// service's default) a folder connector's folder is in that computer, so
// they are always available there. Where they run on the server
// (`host`), their folders are under `<filesDir>/connectors/` on that
// machine, and OPENBOTS_FOLDER_CONNECTORS decides: on by default for a
// self-hosted install, off by default for a managed one that allows host
// stdio. Off, adding one is refused with a clear error, the catalog leaves
// them out, the capabilities say so, one that exists reads as disabled and
// gives a run no tools, and nothing is made under `<filesDir>/connectors/`.

const configFrom = (env: Record<string, string>) =>
  loadConfig({
    OPENBOTS_MASTER_KEY: generateMasterKey(),
    DATABASE_URL: 'postgres://unused',
    ...env,
  });

describe('OPENBOTS_FOLDER_CONNECTORS', () => {
  const managedHost = {
    OPENBOTS_DEPLOYMENT: 'managed',
    OPENBOTS_STDIO_RUNNER: 'host',
    OPENBOTS_ALLOW_HOST_STDIO: '1',
  };
  it('is always on where stdio connectors run in the computer', () => {
    expect(configFrom({ OPENBOTS_DEPLOYMENT: 'managed' }).folderConnectors).toBe(true);
    expect(
      configFrom({ OPENBOTS_DEPLOYMENT: 'managed', OPENBOTS_FOLDER_CONNECTORS: 'false' })
        .folderConnectors,
    ).toBe(true);
    expect(
      configFrom({ OPENBOTS_STDIO_RUNNER: 'computer', OPENBOTS_FOLDER_CONNECTORS: 'off' })
        .folderConnectors,
    ).toBe(true);
  });
  it('follows the setting where they run on the server: on self-hosted, off managed, unless set', () => {
    expect(configFrom({}).folderConnectors).toBe(true);
    expect(configFrom({ OPENBOTS_FOLDER_CONNECTORS: 'off' }).folderConnectors).toBe(false);
    expect(configFrom(managedHost).folderConnectors).toBe(false);
    expect(
      configFrom({ ...managedHost, OPENBOTS_FOLDER_CONNECTORS: 'true' }).folderConnectors,
    ).toBe(true);
    expect(() => configFrom({ OPENBOTS_FOLDER_CONNECTORS: 'maybe' })).toThrow(
      /OPENBOTS_FOLDER_CONNECTORS/,
    );
  });
});

describe('the storage warning at start', () => {
  const s3 = {
    OPENBOTS_STORAGE_DRIVER: 's3',
    OPENBOTS_S3_BUCKET: 'openbots-bucket',
    OPENBOTS_S3_ENDPOINT: 'https://storage.example.com',
    OPENBOTS_S3_ACCESS_KEY_ID: 'AKIAEXAMPLEKEY',
    OPENBOTS_S3_SECRET_ACCESS_KEY: 'a-secret-that-is-never-said',
  };
  it('warns when the s3 driver runs with folder connectors on, naming no value', () => {
    const warning = storageWarning(configFrom(s3));
    expect(warning).toContain('OPENBOTS_FOLDER_CONNECTORS');
    for (const value of Object.values(s3).slice(1)) expect(warning).not.toContain(value);
  });
  it('is quiet with the local driver, with folder connectors off, or with them in the computer', () => {
    expect(storageWarning(configFrom({}))).toBeNull();
    expect(storageWarning(configFrom({ ...s3, OPENBOTS_FOLDER_CONNECTORS: 'false' }))).toBeNull();
    // Managed: stdio connectors, folders included, run in each member's computer.
    expect(storageWarning(configFrom({ ...s3, OPENBOTS_DEPLOYMENT: 'managed' }))).toBeNull();
    expect(storageWarning(configFrom({ ...s3, OPENBOTS_STDIO_RUNNER: 'computer' }))).toBeNull();
    expect(
      storageWarning(
        configFrom({
          ...s3,
          OPENBOTS_DEPLOYMENT: 'managed',
          OPENBOTS_STDIO_RUNNER: 'host',
          OPENBOTS_ALLOW_HOST_STDIO: '1',
          OPENBOTS_FOLDER_CONNECTORS: 'true',
        }),
      ),
    ).toContain('OPENBOTS_FOLDER_CONNECTORS');
  });
});

describe('folder connectors on the server where they are off (managed, host stdio)', () => {
  let t: TestApp;
  let filesDir: string;
  let cookie: string;
  let viewer: { id: string; workspaceId: string };
  let existing: string;
  let botId: string;

  beforeAll(async () => {
    filesDir = mkdtempSync(join(tmpdir(), 'openbots-folders-off-'));
    t = await createTestApp({
      OPENBOTS_DEPLOYMENT: 'managed',
      OPENBOTS_SIGNUP_MODE: 'open',
      OPENBOTS_FILES_DIR: filesDir,
      // Host stdio, so a folder would be made on this server's disk if one ran.
      OPENBOTS_STDIO_RUNNER: 'host',
      OPENBOTS_ALLOW_HOST_STDIO: '1',
    });
    expect(t.deps.config.folderConnectors).toBe(false);
    cookie = (await t.signUp('owner@example.com')).cookie!;
    viewer = {
      id: await t.userId('owner@example.com'),
      workspaceId: await t.defaultOrganization(),
    };
    // A row from when they were on, or from the computer runner.
    const on = { ...t.deps, config: { ...t.deps.config, folderConnectors: true } };
    const record = await t.inOrganization(() =>
      createConnector(on, viewer, { catalogId: 'filesystem', params: { root: 'notes' } }),
    );
    existing = record.row.id;
    await t.db.insert(schema.connectorTools).values({
      workspaceId: viewer.workspaceId,
      connectorId: existing,
      name: 'read_file',
      description: 'Reads a file',
      inputSchema: { type: 'object' },
      annotations: {},
    });
    const bot = await call('POST', '/bots', { name: 'Folder Bot' });
    expect(bot.status).toBe(201);
    botId = ((await bot.json()) as { id: string }).id;
  });
  afterAll(async () => {
    await closeMcpManager(t.ownerDeps);
    await t.close();
    rmSync(filesDir, { recursive: true, force: true });
  });

  async function call(method: string, path: string, body?: unknown) {
    return t.app.request(`/api/v1${path}`, {
      method,
      headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  const problem = async (res: Response) => (await res.json()) as { code: string; detail?: string };

  it('says so in the capabilities, and the catalog leaves them out', async () => {
    const caps = await (await t.app.request('/api/v1/capabilities')).json();
    expect(caps).toMatchObject({ deployment: 'managed', folderConnectors: false });
    const catalog = (await (await call('GET', '/connectors/catalog')).json()) as {
      items: { id: string }[];
    };
    expect(catalog.items.length).toBeGreaterThan(0);
    expect(catalog.items.map((e) => e.id)).not.toContain('filesystem');
  });

  it('refuses to add one with a clear error', async () => {
    const res = await call('POST', '/connectors', {
      catalogId: 'filesystem',
      params: { root: 'projects' },
    });
    expect(res.status).toBe(403);
    const body = await problem(res);
    expect(body.code).toBe('FOLDER_CONNECTORS_UNAVAILABLE');
    expect(JSON.stringify(body)).toContain('Folder connectors are not available on this server');
  });

  it('shows one that exists as disabled, and refuses to test or change it', async () => {
    const list = (await (await call('GET', '/connectors')).json()) as {
      items: { id: string; disabledByAdmin: boolean }[];
    };
    expect(list.items.find((c) => c.id === existing)?.disabledByAdmin).toBe(true);
    const tested = await call('POST', `/connectors/${existing}/test`);
    expect(tested.status).toBe(403);
    expect((await problem(tested)).code).toBe('FOLDER_CONNECTORS_UNAVAILABLE');
    const changed = await call('PATCH', `/connectors/${existing}`, { params: { root: 'other' } });
    expect(changed.status).toBe(403);
    expect((await problem(changed)).code).toBe('FOLDER_CONNECTORS_UNAVAILABLE');
  });

  it('gives a Bot none of its tools, and a call is refused rather than failing the run', async () => {
    expect(await t.inOrganization(() => listToolsForBot(t.deps, botId))).toEqual([]);
    const defaults = await t.inOrganization(() => botToolDefaults(t.deps, viewer, botId));
    const tool = defaults.find((d) => d.connectorId === existing);
    expect(tool?.disabledByAdmin).toBe(true);
    const slug = (
      await t.db.select().from(schema.connectors).where(eq(schema.connectors.id, existing))
    )[0]!.slug;
    await expect(
      t.inOrganization(() => callToolForBot(t.deps, botId, slug, 'read_file', {})),
    ).rejects.toMatchObject({ code: 'TOOL_NOT_PERMITTED' });
  });

  it('never makes a folder on this server', async () => {
    const [row] = await t.db
      .select()
      .from(schema.connectors)
      .where(eq(schema.connectors.id, existing));
    await expect(stdioSpawnFor(t.deps, row!)).rejects.toThrow(
      'Folder connectors are not available',
    );
    expect(existsSync(join(filesDir, 'connectors'))).toBe(false);
  });

  it('still deletes one', async () => {
    expect((await call('DELETE', `/connectors/${existing}`)).status).toBe(204);
  });
});

describe('folder connectors on a self-hosted install', () => {
  let t: TestApp;
  let filesDir: string;

  beforeAll(async () => {
    filesDir = mkdtempSync(join(tmpdir(), 'openbots-folders-on-'));
    t = await createTestApp({ OPENBOTS_FILES_DIR: filesDir });
  });
  afterAll(async () => {
    await closeMcpManager(t.ownerDeps);
    await t.close();
    rmSync(filesDir, { recursive: true, force: true });
  });

  it('offers and adds them as before', async () => {
    const cookie = (await t.signUp('self@example.com')).cookie!;
    const request = (method: string, path: string, body?: unknown) =>
      t.app.request(`/api/v1${path}`, {
        method,
        headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const caps = await (await t.app.request('/api/v1/capabilities')).json();
    expect(caps).toMatchObject({ deployment: 'self_hosted', folderConnectors: true });
    const catalog = (await (await request('GET', '/connectors/catalog')).json()) as {
      items: { id: string }[];
    };
    expect(catalog.items.map((e) => e.id)).toContain('filesystem');
    const res = await request('POST', '/connectors', {
      catalogId: 'filesystem',
      params: { root: 'notes' },
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { disabledByAdmin: boolean }).disabledByAdmin).toBe(false);
  });
});

describe('folder connectors in the computer on the managed service', () => {
  let t: TestApp;
  let filesDir: string;

  beforeAll(async () => {
    filesDir = mkdtempSync(join(tmpdir(), 'openbots-folders-computer-'));
    // The managed defaults: stdio connectors run in each member's computer.
    t = await createTestApp({
      OPENBOTS_DEPLOYMENT: 'managed',
      OPENBOTS_SIGNUP_MODE: 'open',
      OPENBOTS_FILES_DIR: filesDir,
    });
    expect(t.deps.config.stdioRunner).toBe('computer');
  });
  afterAll(async () => {
    await closeMcpManager(t.ownerDeps);
    await t.close();
    rmSync(filesDir, { recursive: true, force: true });
  });

  it('offers and adds them, and makes nothing on this server', async () => {
    const cookie = (await t.signUp('member@example.com')).cookie!;
    const request = (method: string, path: string, body?: unknown) =>
      t.app.request(`/api/v1${path}`, {
        method,
        headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const caps = await (await t.app.request('/api/v1/capabilities')).json();
    expect(caps).toMatchObject({ deployment: 'managed', folderConnectors: true });
    const catalog = (await (await request('GET', '/connectors/catalog')).json()) as {
      items: { id: string }[];
    };
    expect(catalog.items.map((e) => e.id)).toContain('filesystem');
    const res = await request('POST', '/connectors', {
      catalogId: 'filesystem',
      params: { root: 'notes' },
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { disabledByAdmin: boolean }).disabledByAdmin).toBe(false);
    expect(existsSync(join(filesDir, 'connectors'))).toBe(false);
  });
});
