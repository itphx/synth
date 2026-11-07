import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStandaloneApp } from './app.js';

/**
 * Контур плана/журнала/ToDo в **standalone**-ядре (PROP-054): фабрики core
 * смонтированы в `server/app/mount-routes.ts` — проверяем, что эндпоинты живые.
 */
describe('Standalone: контур плана/журнала/ToDo (PROP-054)', () => {
  let dir: string;
  let handle: Awaited<ReturnType<typeof createStandaloneApp>> | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'synth-standalone-work-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('план, журнал, инварианты и ToDo отвечают', async () => {
    handle = await createStandaloneApp({ port: 0, dataDir: dir, apiKey: 'test-key' });
    const app = handle.app;

    const created = await app.request('/api/v2/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-key' },
      body: JSON.stringify({ name: 'План' }),
    });
    expect(created.status).toBe(201);
    const project = (await created.json()) as { id: string };

    const plan = await app.request(`/api/v2/projects/${project.id}/plan`, {
      headers: { Authorization: 'Bearer test-key' },
    });
    expect(plan.status).toBe(200);

    const log = await app.request(`/api/v2/projects/${project.id}/log`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-key' },
      body: JSON.stringify({ text: 'запись' }),
    });
    expect(log.status).toBe(201);

    const session = await app.request('/api/v2/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-key' },
      body: JSON.stringify({ title: 'Сессия' }),
    });
    expect(session.status).toBe(201);
    const createdSession = (await session.json()) as { id: string };

    const todos = await app.request(`/api/v2/sessions/${createdSession.id}/todos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-key' },
      body: JSON.stringify({ content: 'Шаг' }),
    });
    expect(todos.status).toBe(200);
    const todosBody = (await todos.json()) as { todos: Array<{ content: string }> };
    expect(todosBody.todos[0]!.content).toBe('Шаг');
  });
});
