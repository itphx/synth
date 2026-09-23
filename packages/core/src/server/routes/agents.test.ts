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
