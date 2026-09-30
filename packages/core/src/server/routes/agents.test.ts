import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentRoutes } from './agents.js';
import { JsonStore } from '../../storage/json-store.js';
import { DEFAULT_AGENT_ID } from '../../engine/agents/index.js';
import type { AgentDefinition } from '@itphx/synth-shared';
import type { AuthKit } from '../../auth/local.js';

function createMockAuth(): AuthKit {
  return {
    getCurrentUser: () => null,
    requireAuth: async (_c: Context, next: Next) => { await next(); },
  } as unknown as AuthKit;
}

describe('Agent API Routes — default_agent', () => {
  let tmpDir: string;
  let store: JsonStore<AgentDefinition>;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-core-agents-test-'));
    store = new JsonStore<AgentDefinition>({ dataDir: tmpDir, subdir: 'agents' });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function createTestApp(getDefaultAgentId?: () => string | Promise<string>) {
    const app = new Hono();
    app.route('/api/v2/agents', createAgentRoutes(createMockAuth(), store, undefined, getDefaultAgentId));
    return app;
  }

  it('GET /agents без геттера отдаёт DEFAULT_AGENT_ID', async () => {
    const app = createTestApp();
    const res = await app.request('/api/v2/agents');
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.default_agent).toBe(DEFAULT_AGENT_ID);
  });

  it('GET /agents отдаёт значение геттера', async () => {
    const app = createTestApp(() => 'analyst');
    const res = await app.request('/api/v2/agents');
    const body: any = await res.json();
    expect(body.default_agent).toBe('analyst');
  });

  it('GET /agents/all отдаёт значение геттера', async () => {
    const app = createTestApp(async () => 'developer');
    const res = await app.request('/api/v2/agents/all');
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.default_agent).toBe('developer');
  });
});

describe('Agent API Routes — CRUD (core superset)', () => {
  let tmpDir: string;
  let store: JsonStore<AgentDefinition>;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-core-agents-crud-'));
    store = new JsonStore<AgentDefinition>({ dataDir: tmpDir, subdir: 'agents' });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function createTestApp() {
    const app = new Hono();
    app.route('/api/v2/agents', createAgentRoutes(createMockAuth(), store));
    return app;
  }

  it('GET /agents/all: is_builtin отражает реальную принадлежность', async () => {
    const app = createTestApp();
    await app.request('/api/v2/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'custom1', display_name: 'Custom' }),
    });

    const res = await app.request('/api/v2/agents/all');
    const body: any = await res.json();
    const builtin = body.agents.find((a: any) => a.id === 'assistant');
    const custom = body.agents.find((a: any) => a.id === 'custom1');
    expect(builtin.is_builtin).toBe(true);
    expect(custom.is_builtin).toBe(false);
  });

  it('POST /agents сохраняет topK и берёт fallback из builtin', async () => {
    const app = createTestApp();
    const res = await app.request('/api/v2/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'assistant', top_k: 50 }),
    });
    expect(res.status).toBe(201);
    const stored = await store.load('assistant');
    expect(stored?.topK).toBe(50);
    expect(stored?.displayName).toBe('Ассистент');
    expect(Array.isArray(stored?.capabilities)).toBe(true);
    expect((stored?.capabilities ?? []).length).toBeGreaterThan(0);
  });

  it('GET /agents/:id отдаёт builtin и 404 для неизвестного', async () => {
    const app = createTestApp();
    const ok = await app.request('/api/v2/agents/assistant');
    expect(ok.status).toBe(200);
    const agent: any = await ok.json();
    expect(agent.id).toBe('assistant');

    const missing = await app.request('/api/v2/agents/nope');
    expect(missing.status).toBe(404);
    const body: any = await missing.json();
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('PATCH /agents/:id/enabled переключает builtin (override)', async () => {
    const app = createTestApp();
    const res = await app.request('/api/v2/agents/assistant/enabled', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body).toEqual({ id: 'assistant', enabled: false });
    expect((await store.load('assistant'))?.enabled).toBe(false);

    const missing = await app.request('/api/v2/agents/nope/enabled', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    expect(missing.status).toBe(404);
  });

  it('DELETE /agents/:id: builtin без override → 404, custom → deleted, override → reset', async () => {
    const app = createTestApp();

    const builtinNoOverride = await app.request('/api/v2/agents/assistant', { method: 'DELETE' });
    expect(builtinNoOverride.status).toBe(404);

    await app.request('/api/v2/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'custom2', display_name: 'Custom 2' }),
    });
    const customDelete = await app.request('/api/v2/agents/custom2', { method: 'DELETE' });
    expect(customDelete.status).toBe(200);
    expect((await customDelete.json() as any).status).toBe('deleted');

    await app.request('/api/v2/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'assistant', display_name: 'Override' }),
    });
    const reset = await app.request('/api/v2/agents/assistant', { method: 'DELETE' });
    expect(reset.status).toBe(200);
    expect((await reset.json() as any).status).toBe('reset');
    expect(await store.load('assistant')).toBeNull();
  });
});
