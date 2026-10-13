// AD-052 (этап IV) / AD-089: сквозной срез SSE `GET /api/v2/events`.
// Машинный watcher (service-key со scope `events:watch`) должен получать события
// сессий, созданных/владеемых ДРУГИМ пользователем (паритет со standalone-core
// `subscribeAll`) — именно этого не хватало Telegram-шлюзу. Обычный USER видит
// только свои сессии, а scope-гейт `events:watch` не ослабляется.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBackendApp } from '../app.js';
import type { BackendAppHandle } from '../app.js';

const ADMIN_KEY = 'admin-key-123';
const USER_KEY = 'user-key-456';

describe('AD-052 (этап IV): SSE watch-all для service-key (backend)', () => {
  let dataDir: string;
  let backend: BackendAppHandle;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'synth-backend-sse-'));
    backend = await createBackendApp({ dataDir, authDebug: true });
  });

  afterAll(async () => {
    backend.stopScheduler();
    backend.stopEphemeralSweeper();
    backend.stopEventJournalPruner();
    // Фоновая атомарная запись store может пересечься с удалением.
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const req = async (path: string, init: RequestInit = {}, token?: string): Promise<Response> =>
    backend.app.request(path, {
      ...init,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init.headers ?? {}),
      },
    });

  async function createServiceKey(body: Record<string, unknown>): Promise<{ id: string; key: string }> {
    const res = await req(
      '/api/v2/service-keys',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
      ADMIN_KEY,
    );
    expect(res.status).toBe(201);
    return (await res.json()) as { id: string; key: string };
  }

  async function createSession(name: string, token: string): Promise<string> {
    const res = await req(
      '/api/v2/sessions',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) },
      token,
    );
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: string }).id;
  }

  /**
   * Читает SSE-поток до появления всех `needles` (или таймаут). Возвращает
   * накопленный текст — по нему проверяем и доставленные, и отсутствующие события.
   */
  async function readFor(res: Response, needles: string[], timeoutMs = 2000): Promise<string> {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let acc = '';
    const deadline = Date.now() + timeoutMs;
    try {
      while (Date.now() < deadline) {
        const remaining = Math.max(1, deadline - Date.now());
        const result = await Promise.race([
          reader.read(),
          new Promise<{ done: boolean; value?: Uint8Array }>((resolve) =>
            setTimeout(() => resolve({ done: true }), remaining),
          ),
        ]);
        if (result.done) break;
        acc += decoder.decode(result.value);
        if (needles.every((n) => acc.includes(n))) break;
      }
    } finally {
      void reader.cancel().catch(() => {});
    }
    return acc;
  }

  it('service-key (events:watch) получает событие чужой сессии без владения', async () => {
    const key = await createServiceKey({ label: 'tg-gw-sse', roles: ['USER'], scopes: ['events:watch'] });
    const abort = new AbortController();
    const res = await backend.app.request('/api/v2/events', {
      headers: { Authorization: `Bearer ${key.key}` },
      signal: abort.signal,
    });
    expect(res.status).toBe(200);

    // Дать хабу зарегистрировать клиента (для all-клиента подписка синхронна).
    await new Promise((r) => setTimeout(r, 30));
    backend.eventBus.publish('session-foreign-svc', 'stream.done', { answer: 'pong' });

    const text = await readFor(res, ['"session-foreign-svc"', 'stream.done']);
    abort.abort();
    expect(text).toContain('"session-foreign-svc"');
    expect(text).toContain('stream.done');
  });

  it('обычный USER получает свои сессии, но не чужие', async () => {
    const own = await createSession('own', USER_KEY);

    const abort = new AbortController();
    const res = await backend.app.request('/api/v2/events', {
      headers: { Authorization: `Bearer ${USER_KEY}` },
      signal: abort.signal,
    });
    expect(res.status).toBe(200);

    // Дать хабу выполнить `listSessions({ userId })` и подписаться на свою сессию.
    await new Promise((r) => setTimeout(r, 50));
    backend.eventBus.publish('session-foreign-user', 'stream.done', { tag: 'foreign' });
    backend.eventBus.publish(own, 'stream.done', { tag: 'own' });

    const text = await readFor(res, ['"tag":"own"']);
    abort.abort();
    expect(text).toContain('"tag":"own"');
    expect(text).not.toContain('"tag":"foreign"');
  });

  it('scope-гейт events:watch не ослаблен: service-key без scope → 403 SCOPE_REQUIRED', async () => {
    const key = await createServiceKey({ label: 'tg-gw-noscope', roles: ['USER'], scopes: ['sessions:read'] });
    const res = await req('/api/v2/events', {}, key.key);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('SCOPE_REQUIRED');
  });
});
