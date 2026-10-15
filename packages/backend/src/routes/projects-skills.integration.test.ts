// ADR-046 §4.5: project-scope скиллов — RBAC симметричен project-MCP:
// owner/LEAD/ADMIN (canManageProjectMcp) и на чтение, и на запись; посторонний USER — 403.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBackendApp } from '../app.js';
import type { BackendAppHandle } from '../app.js';

const KEYS = {
  developer: 'user-key-456',
  lead: 'lead-key-789',
  admin: 'admin-key-123',
  auditor: 'auditor-key-012',
} as const;

function headers(user: keyof typeof KEYS): Record<string, string> {
  return { Authorization: `Bearer ${KEYS[user]}`, 'Content-Type': 'application/json' };
}

describe('project skills scope RBAC (ADR-046 §4.5)', () => {
  let tmpDir: string;
  let backend: BackendAppHandle;
  let projectId: string;

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-proj-skills-'));
    backend = await createBackendApp({ dataDir: tmpDir, authDebug: true });
    const created = await backend.app.request('/api/v2/projects', {
      method: 'POST',
      headers: headers('developer'),
      body: JSON.stringify({ name: 'Skills RBAC' }),
    });
    expect(created.status).toBe(201);
    projectId = ((await created.json()) as { id: string }).id;
  });

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  const put = (user: keyof typeof KEYS, id = projectId) =>
    backend.app.request(`/api/v2/projects/${id}/skills`, {
      method: 'PUT',
      headers: headers(user),
      body: JSON.stringify({ enabled: ['api-review'] }),
    });
  const get = (user: keyof typeof KEYS, id = projectId) =>
    backend.app.request(`/api/v2/projects/${id}/skills`, { headers: headers(user) });

  it('owner (developer) может GET и PUT', async () => {
    expect((await get('developer')).status).toBe(200);
    expect((await put('developer')).status).toBe(200);
  });

  it('LEAD может PUT (как project-MCP)', async () => {
    expect((await put('lead')).status).toBe(200);
  });

  it('ADMIN может PUT', async () => {
    expect((await put('admin')).status).toBe(200);
  });

  it('посторонний USER (auditor) получает 403 на GET и PUT', async () => {
    expect((await get('auditor')).status).toBe(403);
    expect((await put('auditor')).status).toBe(403);
  });

  it('несуществующий проект → 404', async () => {
    expect((await get('admin', 'nope')).status).toBe(404);
    expect((await put('admin', 'nope')).status).toBe(404);
  });
});
