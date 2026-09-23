import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentRoutes } from './agents.js';
import { JsonStore } from '../storage/json-store.js';
import type { AgentDefinition } from '@itphx/synth-shared';
import { AgentRegistry, DEFAULT_AGENT_ID } from '@itphx/synth-core';

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

function createTestApp(agentRegistry?: AgentRegistry, getDefaultAgentId?: () => string | Promise<string>) {
  const app = new Hono();
  const kit = createMockKit();
  const routes = createAgentRoutes(kit as any, store, undefined, agentRegistry, getDefaultAgentId);
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

describe('Agent API Routes — синхронизация с AgentRegistry', () => {
  let registry: AgentRegistry;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-agents-test-'));
    store = new JsonStore<AgentDefinition>({ dataDir: tmpDir, subdir: 'agents' });
    registry = new AgentRegistry();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('POST /agents регистрирует custom-агента в registry (context_file)', async () => {
    const app = createTestApp(registry);
    const res = await app.request('/api/v2/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'bankassistadv',
        display_name: 'Банковский ассистент (Adv)',
        context_file: 'BANKASSIST_ADVANCED.md',
      }),
    });
    expect(res.status).toBe(201);
    expect(registry.get('bankassistadv')?.contextFile).toBe('BANKASSIST_ADVANCED.md');
  });

  it('GET /agents отдаёт только основных (primary)', async () => {
    const app = createTestApp(registry);
    const res = await app.request('/api/v2/agents');
    expect(res.status).toBe(200);
    const body: any = await res.json();
    const ids = body.agents.map((a: any) => a.id);
    expect(ids).toContain('assistant');
    expect(ids).toContain('developer');
    expect(ids).not.toContain('general'); // subagent
    expect(ids).not.toContain('explore'); // subagent
    expect(ids).not.toContain('title'); // system
    for (const a of body.agents) {
      expect(Array.isArray(a.agent_mode)).toBe(true);
      expect(a.agent_mode).toContain('primary');
    }
  });

  it('GET /agents/all отдаёт всех агентов (включая subagent и system)', async () => {
    const app = createTestApp(registry);
    const res = await app.request('/api/v2/agents/all');
    expect(res.status).toBe(200);
    const body: any = await res.json();
    const ids = body.agents.map((a: any) => a.id);
    expect(ids).toContain('assistant');
    expect(ids).toContain('general');
    expect(ids).toContain('explore');
    expect(ids).toContain('title');
    const title = body.agents.find((a: any) => a.id === 'title');
    expect(title.agent_mode).toEqual(['system']);
    const general = body.agents.find((a: any) => a.id === 'general');
    expect(general.agent_mode).toEqual(['subagent']);
  });

  it('POST /agents принимает agent_mode массивом', async () => {
    const app = createTestApp(registry);
    const res = await app.request('/api/v2/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'hybrid', display_name: 'Гибрид', agent_mode: ['primary', 'subagent'] }),
    });
    expect(res.status).toBe(201);
    const agent: any = await res.json();
    expect(agent.agentMode).toEqual(['primary', 'subagent']);
    expect(registry.get('hybrid')?.agentMode).toEqual(['primary', 'subagent']);
  });

  it('DELETE /agents/:id убирает custom-агента из registry', async () => {
    const app = createTestApp(registry);
    await app.request('/api/v2/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'bankassistadv', display_name: 'Банковский ассистент (Adv)', context_file: 'BANKASSIST_ADVANCED.md' }),
    });
    expect(registry.get('bankassistadv')).toBeDefined();

    const res = await app.request('/api/v2/agents/bankassistadv', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(registry.get('bankassistadv')).toBeUndefined();
  });

  it('DELETE builtin (reset) возвращает системную дефиницию в registry', async () => {
    const app = createTestApp(registry);
    await app.request('/api/v2/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'assistant', display_name: 'Ассистент', context_file: 'CUSTOM.md' }),
    });
    expect(registry.get('assistant')?.contextFile).toBe('CUSTOM.md');

    const res = await app.request('/api/v2/agents/assistant', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(registry.get('assistant')?.contextFile).toBe('ASSISTANT.md');
  });
});

describe('Agent API Routes — default_agent', () => {
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-agents-test-'));
    store = new JsonStore<AgentDefinition>({ dataDir: tmpDir, subdir: 'agents' });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('GET /agents без геттера отдаёт DEFAULT_AGENT_ID', async () => {
    const app = createTestApp();
    const res = await app.request('/api/v2/agents');
    const body: any = await res.json();
    expect(body.default_agent).toBe(DEFAULT_AGENT_ID);
  });

  it('GET /agents отдаёт значение геттера', async () => {
    const app = createTestApp(undefined, () => 'analyst');
    const res = await app.request('/api/v2/agents');
    const body: any = await res.json();
    expect(body.default_agent).toBe('analyst');
  });

  it('GET /agents/all отдаёт значение геттера', async () => {
    const app = createTestApp(undefined, async () => 'developer');
    const res = await app.request('/api/v2/agents/all');
    const body: any = await res.json();
    expect(body.default_agent).toBe('developer');
  });
});
