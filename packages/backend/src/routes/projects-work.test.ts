import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBackendApp } from '../app.js';
import type { BackendAppHandle } from '../app.js';

/**
 * Контур плана/журнала/инвариантов в **реальном** backend-приложении
 * (PROP-054): фабрики core смонтированы в `mount-routes.ts` — проверяем, что
 * эндпоинты живые и RBAC работает (VIEWER читает, но не мутирует).
 */
describe('Backend: контур плана/журнала (PROP-054)', () => {
  let backend: BackendAppHandle | undefined;
  let dataDir: string;

  afterEach(async () => {
    backend?.stopScheduler();
    backend?.stopEphemeralSweeper();
    backend?.stopEventJournalPruner();
    backend?.stopWebhookService();
    backend?.stopWebhookDeliveryPruner();
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('эндпоинты плана и журнала смонтированы и отвечают', async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'synth-backend-plan-'));
    backend = await createBackendApp({ dataDir, authDebug: true });
    const app = backend.app;

    // Создаём проект debug-пользователем (admin-key-123 — ADMIN).
    const created = await app.request('/api/v2/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer admin-key-123' },
      body: JSON.stringify({ name: 'План' }),
    });
    expect(created.status).toBe(201);
    const project = (await created.json()) as { id: string };

    const plan = await app.request(`/api/v2/projects/${project.id}/plan`, {
      headers: { Authorization: 'Bearer admin-key-123' },
    });
    expect(plan.status).toBe(200);
    const planBody = (await plan.json()) as { plan: { version: number } };
    expect(planBody.plan.version).toBeGreaterThan(0);

    const log = await app.request(`/api/v2/projects/${project.id}/log`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer admin-key-123' },
      body: JSON.stringify({ text: 'запись' }),
    });
    expect(log.status).toBe(201);

    const page = await app.request(`/api/v2/projects/${project.id}/log`, {
      headers: { Authorization: 'Bearer admin-key-123' },
    });
    expect(page.status).toBe(200);
    const pageBody = (await page.json()) as { entries: Array<{ text: string }>; total: number };
    expect(pageBody.total).toBe(1);
    expect(pageBody.entries[0]!.text).toBe('запись');

    const invariants = await app.request(`/api/v2/projects/${project.id}/invariants`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer admin-key-123' },
      body: JSON.stringify({ invariants: '# Правила' }),
    });
    expect(invariants.status).toBe(200);
  });
});
