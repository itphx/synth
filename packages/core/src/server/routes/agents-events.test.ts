/**
 * Событие шины `agents.updated` на HTTP-путях реестра агентов.
 *
 * Баг: «список агентов в UI не обновляется после создания/обновления агента,
 * пока не перезагрузишь страницу». Причина — сервер молчал о мутации реестра:
 * админ-панели и селектам агента нечего было перечитывать.
 *
 * Контракт проверяется здесь целиком:
 * - публикуется на POST (`save`), DELETE (`reset` для builtin-override,
 *   `delete` для custom) и PATCH enabled (`enable`);
 * - **не** публикуется при ошибке валидации (400) и 404;
 * - повтор без изменений (`POST` тем же телом, `PATCH` тем же значением) —
 *   без события: иначе каждая открытая админка дёргала бы `GET /agents/all`;
 * - payload — `{ id, action }` в инстансный канал (никаких тяжёлых полей).
 *
 * Шина подменена фейком (`onAgentsChanged` — тот же хук, что у
 * `agentsChangedPublisher`): тест про контракт фабрики, а не про EventBus.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentRoutes } from './agents.js';
import { JsonStore } from '../../storage/json-store.js';
import type { AgentDefinition } from '@itphx/synth-shared';
import type { AuthKit } from '../../auth/local.js';
import type { AgentChangedInfo } from '../../events/agents-events.js';
import { publishAgentsUpdated } from '../../events/agents-events.js';

function createMockAuth(): AuthKit {
  return {
    getCurrentUser: () => null,
    requireAuth: async (_c: Context, next: Next) => { await next(); },
  } as unknown as AuthKit;
}

/** Записанное событие `agents.updated` (канал + payload). */
interface PublishedEvent {
  channel: string;
  type: string;
  data: Record<string, unknown>;
}

describe('POST/DELETE/PATCH /agents — событие agents.updated', () => {
  let tmpDir: string;
  let store: JsonStore<AgentDefinition>;
  let published: PublishedEvent[];

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-core-agents-events-'));
    store = new JsonStore<AgentDefinition>({ dataDir: tmpDir, subdir: 'agents' });
    published = [];
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function createTestApp() {
    const app = new Hono();
    // Хук — тот же, что ставит точка сборки: `agentsChangedPublisher(bus)`.
    const onAgentsChanged = (info: AgentChangedInfo) =>
      publishAgentsUpdated(
        {
          publishInstance: (type, data = {}) => {
            published.push({ channel: 'instance', type, data });
          },
        },
        info,
      );
    app.route('/api/v2/agents', createAgentRoutes(
      createMockAuth(), store, undefined, undefined, { onAgentsChanged },
    ));
    return app;
  }

  // --- POST ---------------------------------------------------------------

  it('POST нового агента публикует { id, action: save } в инстансный канал', async () => {
    const app = createTestApp();
    const res = await app.request('/api/v2/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'custom1', display_name: 'Первый' }),
    });
    expect(res.status).toBe(201);
    expect(published).toEqual([
      { channel: 'instance', type: 'agents.updated', data: { action: 'save', id: 'custom1' } },
    ]);
  });

  it('POST с изменением существующего агента публикует событие', async () => {
    const app = createTestApp();
    await app.request('/api/v2/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'custom1', display_name: 'Первый' }),
    });
    published.length = 0;

    const res = await app.request('/api/v2/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'custom1', display_name: 'Второй' }),
    });
    expect(res.status).toBe(200);
    expect(published).toHaveLength(1);
    expect(published[0]!.data).toEqual({ action: 'save', id: 'custom1' });
  });

  it('повторное POST тем же телом событие не публикует (идемпотентная запись)', async () => {
    const app = createTestApp();
    const body = JSON.stringify({ id: 'custom1', display_name: 'Первый' });
    await app.request('/api/v2/agents', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
    });
    published.length = 0;

    const res = await app.request('/api/v2/agents', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
    });
    expect(res.status).toBe(200);
    expect(published).toEqual([]);
  });

  it('POST без id (400 VALIDATION_ERROR) событие не публикует', async () => {
    const app = createTestApp();
    const res = await app.request('/api/v2/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ display_name: 'Без идентификатора' }),
    });
    expect(res.status).toBe(400);
    expect(published).toEqual([]);
  });

  it('POST с невалидным id (400 VALIDATION_ERROR) событие не публикует', async () => {
    const app = createTestApp();
    const res = await app.request('/api/v2/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'Плохой id!', display_name: 'X' }),
    });
    expect(res.status).toBe(400);
    expect(published).toEqual([]);
  });

  it('POST с невалидным effort (400 VALIDATION_ERROR) событие не публикует', async () => {
    const app = createTestApp();
    const res = await app.request('/api/v2/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'custom1', effort: 'турбо' }),
    });
    expect(res.status).toBe(400);
    expect(published).toEqual([]);
  });

  // --- DELETE -------------------------------------------------------------

  it('DELETE custom-агента публикует action: delete', async () => {
    const app = createTestApp();
    await app.request('/api/v2/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'custom1', display_name: 'Первый' }),
    });
    published.length = 0;

    const res = await app.request('/api/v2/agents/custom1', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(published).toEqual([
      { channel: 'instance', type: 'agents.updated', data: { action: 'delete', id: 'custom1' } },
    ]);
  });

  it('DELETE несуществующего custom-агента (404) событие не публикует', async () => {
    const app = createTestApp();
    const res = await app.request('/api/v2/agents/nosuch', { method: 'DELETE' });
    expect(res.status).toBe(404);
    expect(published).toEqual([]);
  });

  it('DELETE override встроенного агента публикует action: reset', async () => {
    const app = createTestApp();
    await app.request('/api/v2/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'assistant', display_name: 'Мой ассистент' }),
    });
    published.length = 0;

    const res = await app.request('/api/v2/agents/assistant', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'reset' });
    expect(published).toEqual([
      { channel: 'instance', type: 'agents.updated', data: { action: 'reset', id: 'assistant' } },
    ]);
  });

  it('DELETE встроенного агента без override (404) событие не публикует', async () => {
    const app = createTestApp();
    const res = await app.request('/api/v2/agents/assistant', { method: 'DELETE' });
    expect(res.status).toBe(404);
    expect(published).toEqual([]);
  });

  // --- PATCH enabled ------------------------------------------------------

  it('PATCH enabled публикует action: enable при реальной смене признака', async () => {
    const app = createTestApp();
    await app.request('/api/v2/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'custom1', display_name: 'Первый' }),
    });
    published.length = 0;

    const res = await app.request('/api/v2/agents/custom1/enabled', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(200);
    expect(published).toEqual([
      { channel: 'instance', type: 'agents.updated', data: { action: 'enable', id: 'custom1' } },
    ]);
  });

  it('PATCH enabled тем же значением событие не публикует', async () => {
    const app = createTestApp();
    await app.request('/api/v2/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'custom1', display_name: 'Первый', enabled: false }),
    });
    published.length = 0;

    const res = await app.request('/api/v2/agents/custom1/enabled', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(200);
    expect(published).toEqual([]);
  });

  it('PATCH enabled неизвестного агента (404) событие не публикует', async () => {
    const app = createTestApp();
    const res = await app.request('/api/v2/agents/nosuch/enabled', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(404);
    expect(published).toEqual([]);
  });

  // --- хук необязателен ---------------------------------------------------

  it('без хука фабрика работает как раньше (мутации проходят)', async () => {
    const app = new Hono();
    // Фейковая шина не нужна: хук не передан — публикации нет, падений нет.
    app.route('/api/v2/agents', createAgentRoutes(createMockAuth(), store));
    const res = await app.request('/api/v2/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'custom1', display_name: 'Первый' }),
    });
    expect(res.status).toBe(201);
    expect(await store.exists('custom1')).toBe(true);
  });
});
