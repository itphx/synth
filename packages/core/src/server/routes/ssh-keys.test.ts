import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSshKeyRoutes, createAgentSshKeyRoutes } from './ssh-keys.js';
import { SSHKeyStore } from '../../storage/ssh-key-store.js';
import { clearMasterKeyCache } from '../../security/crypto.js';

const passAuth: MiddlewareHandler = async (_c, next) => { await next(); };

const SECRET_MARKER = 'SUPERSECRETPRIVATEKEYMATERIAL';
const SAMPLE_KEY = `-----BEGIN OPENSSH PRIVATE KEY-----\n${SECRET_MARKER}\n-----END OPENSSH PRIVATE KEY-----`;
const NEW_KEY = `-----BEGIN OPENSSH PRIVATE KEY-----\nNEWSECRETMATERIAL\n-----END OPENSSH PRIVATE KEY-----`;

describe('SSH Keys API Routes (AD-076 §T5)', () => {
  let dataDir: string;
  let store: SSHKeyStore;
  let app: Hono;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'synth-sshkeys-routes-'));
    store = new SSHKeyStore({ dataDir });
    app = new Hono();
    app.route('/api/v2/ssh-keys', createSshKeyRoutes({ requireAuth: passAuth }, store));
    app.route(
      '/api/v2/agents/:agentId/ssh-keys',
      createAgentSshKeyRoutes({ requireAuth: passAuth }, store),
    );
  });

  afterEach(async () => {
    clearMasterKeyCache();
    await rm(dataDir, { recursive: true, force: true });
  });

  function post(path: string, body: unknown) {
    return app.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  function patch(path: string, body: unknown) {
    return app.request(path, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('create → 201, ответ без privateKey/passphrase', async () => {
    const res = await post('/api/v2/ssh-keys', {
      name: 'deploy',
      privateKey: SAMPLE_KEY,
      passphrase: 'p@ss',
    });
    expect(res.status).toBe(201);
    const body = await res.json() as Record<string, unknown>;
    expect(body.name).toBe('deploy');
    expect(body.id).toBeTruthy();
    expect(JSON.stringify(body)).not.toContain(SECRET_MARKER);
    expect(JSON.stringify(body)).not.toContain('p@ss');
    expect('privateKey' in body).toBe(false);
    expect('passphrase' in body).toBe(false);
  });

  it('list / list?agentId / get', async () => {
    const a = await post('/api/v2/ssh-keys', {
      name: 'a',
      privateKey: SAMPLE_KEY,
      agentIds: ['agent-1'],
    });
    const aId = (await a.json() as { id: string }).id;
    await post('/api/v2/ssh-keys', { name: 'b', privateKey: SAMPLE_KEY });

    const list = await app.request('/api/v2/ssh-keys');
    expect(list.status).toBe(200);
    const all = await list.json() as Array<{ id: string }>;
    expect(all).toHaveLength(2);
    expect(JSON.stringify(all)).not.toContain(SECRET_MARKER);

    const forAgent = await app.request('/api/v2/ssh-keys?agentId=agent-1');
    expect((await forAgent.json() as Array<{ id: string }>).map((k) => k.id)).toEqual([aId]);

    const got = await app.request(`/api/v2/ssh-keys/${aId}`);
    expect(got.status).toBe(200);
    const meta = await got.json() as Record<string, unknown>;
    expect(meta.name).toBe('a');
    expect(JSON.stringify(meta)).not.toContain(SECRET_MARKER);

    const missing = await app.request('/api/v2/ssh-keys/nope');
    expect(missing.status).toBe(404);
    const err = await missing.json() as { error: { code: string } };
    expect(err.error.code).toBe('sshkey.not_found');
  });

  it('patch (в т.ч. смена privateKey) → 200 и reveal даёт новое значение', async () => {
    const created = await post('/api/v2/ssh-keys', { name: 'upd', privateKey: SAMPLE_KEY });
    const id = (await created.json() as { id: string }).id;

    const res = await patch(`/api/v2/ssh-keys/${id}`, { name: 'upd-2', privateKey: NEW_KEY });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.name).toBe('upd-2');
    expect(JSON.stringify(body)).not.toContain('NEWSECRETMATERIAL');

    expect(await store.reveal(id)).toEqual({ privateKey: NEW_KEY });

    const missing = await patch('/api/v2/ssh-keys/nope', { name: 'x' });
    expect(missing.status).toBe(404);
  });

  it('delete → 204, затем 404', async () => {
    const created = await post('/api/v2/ssh-keys', { name: 'del', privateKey: SAMPLE_KEY });
    const id = (await created.json() as { id: string }).id;

    const del = await app.request(`/api/v2/ssh-keys/${id}`, { method: 'DELETE' });
    expect(del.status).toBe(204);
    expect(await store.get(id)).toBeNull();

    const again = await app.request(`/api/v2/ssh-keys/${id}`, { method: 'DELETE' });
    expect(again.status).toBe(404);
  });

  it('конфликт имени → 409 sshkey.name_exists', async () => {
    await post('/api/v2/ssh-keys', { name: 'dup', privateKey: SAMPLE_KEY });
    const res = await post('/api/v2/ssh-keys', { name: 'DUP', privateKey: SAMPLE_KEY });
    expect(res.status).toBe(409);
    const err = await res.json() as { error: { code: string; error: string } };
    expect(err.error.code).toBe('sshkey.name_exists');
    expect(err.error.error).toContain('DUP');
  });

  it('пустой privateKey (пробелы) → 400 VALIDATION_ERROR', async () => {
    const res = await post('/api/v2/ssh-keys', { name: 'bad', privateKey: '   ' });
    expect(res.status).toBe(400);
    const err = await res.json() as { error: { code: string } };
    expect(err.error.code).toBe('VALIDATION_ERROR');
  });

  it('nested: GET по агенту, POST добавляет agentId, DELETE отвязывает', async () => {
    // GET пустой.
    const empty = await app.request('/api/v2/agents/agent-1/ssh-keys');
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual([]);

    // POST добавляет agentId в agentIds (объединяя с переданными).
    const created = await post('/api/v2/agents/agent-1/ssh-keys', {
      name: 'nested',
      privateKey: SAMPLE_KEY,
      agentIds: ['agent-2'],
    });
    expect(created.status).toBe(201);
    const body = await created.json() as { id: string; agentIds: string[] };
    expect(body.agentIds.sort()).toEqual(['agent-1', 'agent-2']);
    expect(JSON.stringify(body)).not.toContain(SECRET_MARKER);

    // GET по агенту находит ключ.
    const forAgent = await app.request('/api/v2/agents/agent-1/ssh-keys');
    expect((await forAgent.json() as Array<{ id: string }>).map((k) => k.id)).toEqual([body.id]);

    // DELETE — отвязка: ключ остаётся в flat-списке, но пропадает у агента.
    const unlinked = await app.request(`/api/v2/agents/agent-1/ssh-keys/${body.id}`, {
      method: 'DELETE',
    });
    expect(unlinked.status).toBe(200);
    const unlinkedBody = await unlinked.json() as { id: string; agentIds: string[] };
    expect(unlinkedBody.agentIds).toEqual(['agent-2']);
    expect(await store.get(body.id)).not.toBeNull();

    const flat = await app.request('/api/v2/ssh-keys');
    expect((await flat.json() as Array<{ id: string }>).map((k) => k.id)).toEqual([body.id]);

    const agentAfter = await app.request('/api/v2/agents/agent-1/ssh-keys');
    expect(await agentAfter.json()).toEqual([]);
  });

  it('nested: неизвестный key id → 404', async () => {
    const res = await app.request('/api/v2/agents/agent-1/ssh-keys/missing', { method: 'DELETE' });
    expect(res.status).toBe(404);
    const err = await res.json() as { error: { code: string } };
    expect(err.error.code).toBe('sshkey.not_found');
  });

  it('секретов нет ни в одном ответе (JSON.stringify)', async () => {
    await post('/api/v2/ssh-keys', { name: 's1', privateKey: SAMPLE_KEY, passphrase: 'p@ss' });
    await post('/api/v2/agents/agent-1/ssh-keys', { name: 's2', privateKey: SAMPLE_KEY });

    const endpoints = [
      '/api/v2/ssh-keys',
      '/api/v2/ssh-keys?agentId=agent-1',
      '/api/v2/agents/agent-1/ssh-keys',
    ];
    for (const path of endpoints) {
      const res = await app.request(path);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).not.toContain(SECRET_MARKER);
      expect(text).not.toContain('p@ss');
      expect(text).not.toContain('privateKey');
      expect(text).not.toContain('passphrase');
    }
  });
});
