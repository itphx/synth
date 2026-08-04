import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentRoutes } from './agents.js';
import { JsonStore } from '../storage/json-store.js';
import type { AgentDefinition } from '@synth/shared';

function createMockKit() {
  return {
    requireAuth: async (_c: Context, next: Next) => {
      await next();
    },
    requireAdmin: async (_c: Context, next: Next) => {
      await next();
    },
  };
}

let tmpDir: string;
let store: JsonStore<AgentDefinition>;

function createTestApp() {
  const app = new Hono();
  const kit = createMockKit();
  const routes = createAgentRoutes(kit as any, store);
  app.route('/api/v2/agents', routes);
  return app;
}

describe('Agent API Routes — валидация id', () => {
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-agents-test-'));
    store = new JsonStore<AgentDefinition>({ dataDir: tmpDir, subdir: 'agents' });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('POST /agents отклоняет id с @', async () => {
    const app = createTestApp();
    const res = await app.request('/api/v2/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: '@test', display_name: 'Test', agent_mode: 'primary' }),
    });
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.message).toContain('ID агента');
  });

  it('POST /agents отклоняет id с кириллицей', async () => {
    const app = createTestApp();
    const res = await app.request('/api/v2/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'тест', display_name: 'Тест', agent_mode: 'primary' }),
    });
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('POST /agents отклоняет id с пробелом', async () => {
    const app = createTestApp();
    const res = await app.request('/api/v2/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'with space', display_name: 'Test', agent_mode: 'primary' }),
    });
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('POST /agents принимает валидный id и сохраняет агента', async () => {
    const app = createTestApp();
    const res = await app.request('/api/v2/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'bankassist', display_name: 'Банковский ассистент', agent_mode: 'primary' }),
    });
    expect(res.status).toBe(201);
    const agent: any = await res.json();
    expect(agent.id).toBe('bankassist');
  });

  it('невалидные id не сохраняются в хранилище', async () => {
    const app = createTestApp();
    await app.request('/api/v2/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: '@bad', display_name: 'Bad' }),
    });
    const list = await store.list();
    expect(list).toHaveLength(0);
  });
});
