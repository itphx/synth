/**
 * Событие шины `memory.updated` на HTTP-путях портала памяти.
 *
 * Баг: «факт, записанный агентом, и индекс, созданный другим админом, видны в
 * разделе „Память“ только после перезагрузки страницы». Причина — сервер молчал
 * о мутации памяти: срезам портала (статус, факты, индексы) нечего было
 * перечитывать, если правка пришла из чата (`memory_write`/`memory_forget`) или
 * из другой вкладки.
 *
 * Писателей у памяти два, и публикация посажена на **запись в порт**:
 *
 * - `PATCH /indexes/:id` (переключатель `enabled`) — единственная мутация
 *   портала, которая пишет порт напрямую, мимо фасада плагина: событие
 *   публикует сам обработчик, ровно **одно**;
 * - `POST /indexes`, `POST /indexes/:id/rebuild`, `DELETE /indexes/:id`,
 *   `POST /consolidate` — исполняются **тулом плагина**, а запись делает
 *   chokepoint `engine/plugins/scoped-memory.ts`: роут молчит, иначе один
 *   запрос давал бы два события (проверяется здесь же, а сам chokepoint — в
 *   `engine/plugins/scoped-memory.test.ts`).
 *
 * Контракт:
 * - payload — только `{ scope: 'indexes', action: 'update', id }`: ни
 *   содержимого корпуса, ни эмбеддингов, ни настроек индекса в событии нет;
 * - ошибки (400 валидация, 403 guard, 404 нет индекса/чужой namespace,
 *   409 инстансный индекс) — **тишина**: публикация только после записи.
 *
 * Шина подменена фейком (`onMemoryChanged` — тот же хук, что у
 * `memoryChangedPublisher`): тест про контракт фабрики, а не про EventBus.
 */
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { createMemoryStorage } from '../../storage/storage-context.js';
import type { StorageContext } from '../../storage/storage-context.js';
import type { MemoryIndexRecord } from '../../storage/ports/memory-index-repository.js';
import {
  createMemoryRoutes,
  MEMORY_NAMESPACE,
  MEMORY_CONSOLIDATE_TOOL_NAME,
  MEMORY_INDEX_TOOL_NAME,
} from './memory.js';
import type { MemoryToolInvokeInput, MemoryToolInvoker } from './memory.js';
import { memoryChangedPublisher } from '../../events/memory-events.js';

/** Записанное событие (канал + тип + payload). */
interface PublishedEvent {
  channel: string;
  type: string;
  data: Record<string, unknown>;
}

/** Фейковая шина: инстансные события складываются в массив. */
function makeBus(published: PublishedEvent[]) {
  return {
    publishInstance: (type: string, data: Record<string, unknown> = {}) => {
      published.push({ channel: 'instance', type, data });
    },
  };
}

/** Auth-заглушка: портал памяти — инстансный ресурс, ролей в контракте нет. */
const requireAuth = async (_c: Context, next: Next) => {
  await next();
};

/** Guard-заглушка «нет прав» — проверяет, что отказ не публикует событие. */
const deny = async (c: Context) =>
  c.json({ error: { code: 'FORBIDDEN', message: 'deny' } }, 403);

/** Рабочий каталог тестового проекта. */
const WORKSPACE = '/srv/workspaces/demo';

/** Запись индекса памяти для теста (по умолчанию — проектный, включённый). */
function makeIndex(overrides: Partial<MemoryIndexRecord> & { id: string }): MemoryIndexRecord {
  return {
    namespace: MEMORY_NAMESPACE,
    name: overrides.id,
    providerId: MEMORY_NAMESPACE,
    scope: 'project',
    source: { kind: 'project' },
    state: 'ready',
    generation: 1,
    fingerprint: { model: 'text-embed', dimension: 8, chunkerVersion: 'v1' },
    stats: { documents: 2, chunks: 5, updatedAt: '2026-10-12T00:00:00.000Z' },
    createdAt: '2026-10-12T00:00:00.000Z',
    updatedAt: '2026-10-12T00:00:00.000Z',
    ...overrides,
  };
}

/** Инвокер-заглушка админ-тула плагина памяти: запоминает вызовы. */
function makeInvoker(
  metadata: Record<string, unknown> = {},
): { invoke: MemoryToolInvoker; calls: MemoryToolInvokeInput[] } {
  const calls: MemoryToolInvokeInput[] = [];
  return {
    calls,
    invoke: async (input) => {
      calls.push(input);
      return { content: 'ok', metadata };
    },
  };
}

interface AppOptions {
  /** Guard «нет прав» вместо passthrough. */
  denyAll?: boolean;
  /** Хук публикации: события складываются сюда. */
  events: PublishedEvent[];
  /** Инвокер админ-тула плагина памяти. */
  invokeTool?: MemoryToolInvoker;
}

/** Приложение с порталом памяти поверх in-memory портов хранения. */
function createApp(options: AppOptions): { app: Hono; storage: StorageContext } {
  const app = new Hono();
  const storage = createMemoryStorage();
  const bus = makeBus(options.events);
  app.route(
    '/api/v2/memory',
    createMemoryRoutes(
      { requireAuth },
      {
        memory: { facts: storage.memoryFacts, indexes: storage.memoryIndexes },
        ...(options.denyAll ? { guard: deny as never } : {}),
        isPluginActive: () => true,
        ...(options.invokeTool ? { invokeTool: options.invokeTool } : {}),
        resolveProject: async (projectId: string) => ({ id: projectId, workspace: WORKSPACE }),
        // Тот же хук, что прокидывает точка сборки (`memoryChangedPublisher(eventBus)`).
        onMemoryChanged: memoryChangedPublisher(bus),
      },
    ),
  );
  return { app, storage };
}

/** PATCH с JSON-телом. */
async function patch(app: Hono, path: string, body: unknown): Promise<Response> {
  return app.request(path, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** POST с JSON-телом. */
async function post(app: Hono, path: string, body: unknown): Promise<Response> {
  return app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('PATCH /memory/indexes/:id — событие memory.updated', () => {
  it('переключатель enabled публикует ровно одно событие {scope:indexes, action:update, id}', async () => {
    const events: PublishedEvent[] = [];
    const { app, storage } = createApp({ events });
    await storage.memoryIndexes.saveIndex(makeIndex({ id: 'i-1', projectId: 'p-1' }));

    const res = await patch(app, '/api/v2/memory/indexes/i-1', { enabled: false });

    expect(res.status).toBe(200);
    expect(events).toEqual([
      {
        channel: 'instance',
        type: 'memory.updated',
        data: { scope: 'indexes', action: 'update', id: 'i-1' },
      },
    ]);
  });

  it('в payload нет содержимого индекса (ни корпуса, ни эмбеддингов, ни настроек)', async () => {
    const events: PublishedEvent[] = [];
    const { app, storage } = createApp({ events });
    await storage.memoryIndexes.saveIndex(
      makeIndex({
        id: 'i-2',
        projectId: 'p-1',
        name: 'корпус проекта demo',
        stats: { documents: 42, chunks: 1337, updatedAt: '2026-10-12T00:00:00.000Z' },
      }),
    );

    const res = await patch(app, '/api/v2/memory/indexes/i-2', { enabled: false });
    expect(res.status).toBe(200);

    expect(events).toHaveLength(1);
    expect(Object.keys(events[0]!.data).sort()).toEqual(['action', 'id', 'scope']);
    const serialized = JSON.stringify(events[0]);
    // Содержимое записи (имя корпуса, статистика, фингерпринт) не просочилось.
    expect(serialized).not.toContain('корпус проекта demo');
    expect(serialized).not.toContain('1337');
    expect(serialized).not.toContain('text-embed');
    expect(serialized).not.toContain(MEMORY_NAMESPACE);
  });

  it('невалидное тело → 400, событий нет', async () => {
    const events: PublishedEvent[] = [];
    const { app, storage } = createApp({ events });
    await storage.memoryIndexes.saveIndex(makeIndex({ id: 'i-1', projectId: 'p-1' }));

    for (const body of [{}, { enabled: 'yes' }, { enabled: 1 }, null]) {
      const res = await patch(app, '/api/v2/memory/indexes/i-1', body);
      expect(res.status).toBe(400);
    }
    expect(events).toEqual([]);
  });

  it('нет прав (guard) → 403, событий нет', async () => {
    const events: PublishedEvent[] = [];
    const { app, storage } = createApp({ events, denyAll: true });
    await storage.memoryIndexes.saveIndex(makeIndex({ id: 'i-1', projectId: 'p-1' }));

    const res = await patch(app, '/api/v2/memory/indexes/i-1', { enabled: false });
    expect(res.status).toBe(403);
    expect(events).toEqual([]);
  });

  it('индекс не найден / чужой namespace → 404, событий нет', async () => {
    const events: PublishedEvent[] = [];
    const { app, storage } = createApp({ events });
    await storage.memoryIndexes.saveIndex(
      makeIndex({ id: 'i-x', namespace: 'plugin:other-plugin' }),
    );

    const missing = await patch(app, '/api/v2/memory/indexes/nope', { enabled: false });
    expect(missing.status).toBe(404);
    const foreign = await patch(app, '/api/v2/memory/indexes/i-x', { enabled: false });
    expect(foreign.status).toBe(404);
    expect(events).toEqual([]);
  });

  it('инстансный индекс → 409 MEMORY_INDEX_NOT_TOGGLEABLE, событий нет', async () => {
    const events: PublishedEvent[] = [];
    const { app, storage } = createApp({ events });
    await storage.memoryIndexes.saveIndex(makeIndex({ id: 'i-inst', scope: 'instance' }));

    const res = await patch(app, '/api/v2/memory/indexes/i-inst', { enabled: false });
    expect(res.status).toBe(409);
    expect(events).toEqual([]);
  });
});

describe('Мутации портала через тул плагина — событие публикует chokepoint, не роут', () => {
  it('POST /indexes: тул вызван, роут событий не публикует', async () => {
    const events: PublishedEvent[] = [];
    const { invoke, calls } = makeInvoker({ indexId: 'i-9', state: 'building' });
    const { app } = createApp({ events, invokeTool: invoke });

    const res = await post(app, '/api/v2/memory/indexes', { projectId: 'p-1' });
    expect(res.status).toBe(202);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.tool).toBe(MEMORY_INDEX_TOOL_NAME);
    // Второго события не будет: запись в порт делает плагин, а его публикация
    // живёт в scoped-обёртке (`engine/plugins/scoped-memory.ts`).
    expect(events).toEqual([]);
  });

  it('POST /indexes/:id/rebuild: тул вызван, роут событий не публикует', async () => {
    const events: PublishedEvent[] = [];
    const { invoke, calls } = makeInvoker({ indexId: 'i-1' });
    const { app, storage } = createApp({ events, invokeTool: invoke });
    await storage.memoryIndexes.saveIndex(makeIndex({ id: 'i-1', projectId: 'p-1' }));

    const res = await post(app, '/api/v2/memory/indexes/i-1/rebuild', { force: true });
    expect(res.status).toBe(202);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.params.action).toBe('rebuild');
    expect(events).toEqual([]);
  });

  it('DELETE /indexes/:id: тул вызван, роут событий не публикует', async () => {
    const events: PublishedEvent[] = [];
    const { invoke, calls } = makeInvoker();
    const { app, storage } = createApp({ events, invokeTool: invoke });
    await storage.memoryIndexes.saveIndex(makeIndex({ id: 'i-1', projectId: 'p-1' }));

    const res = await app.request('/api/v2/memory/indexes/i-1', { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.params.action).toBe('delete');
    expect(events).toEqual([]);
  });

  it('POST /consolidate: тул вызван, роут событий не публикует', async () => {
    const events: PublishedEvent[] = [];
    const { invoke, calls } = makeInvoker({ clusters: 1, superseded: 1, kept: 1, items: [] });
    const { app } = createApp({ events, invokeTool: invoke });

    const res = await post(app, '/api/v2/memory/consolidate', { threshold: 0.9 });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.tool).toBe(MEMORY_CONSOLIDATE_TOOL_NAME);
    expect(events).toEqual([]);
  });
});
