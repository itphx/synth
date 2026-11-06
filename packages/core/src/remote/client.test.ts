import { describe, it, expect, afterEach, vi } from 'vitest';
import { RemoteBackendClient } from './client.js';
import type { RemoteClientOptions } from './client.js';
import { MetricsRegistry } from '../metrics/registry.js';
import { attachHybridMetrics } from '../metrics/collectors/hybrid.js';
import { RemoteError } from './types.js';

/** fetch-мок, висящий вечно, пока не придёт abort — имитация медленного сервера. */
function hangingFetchMock() {
  return vi.fn((_url: string | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      reject(new DOMException('This operation was aborted', 'AbortError'));
    });
  }));
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeClient(overrides: Partial<RemoteClientOptions> = {}): RemoteBackendClient {
  return new RemoteBackendClient({
    backendUrl: 'http://backend.test',
    getToken: async () => 'test-token',
    ...overrides,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('RemoteBackendClient', () => {
  it('успешный GET: возвращает JSON и шлёт Bearer-токен', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([{ id: 'p1', name: 'Проект' }]));
    vi.stubGlobal('fetch', fetchMock);

    const result = await makeClient().listProjects();

    // Старый сервер отдаёт массив — он нормализуется в объект-список.
    expect(result).toEqual({
      projects: [{ id: 'p1', name: 'Проект' }],
      total: 1,
      paginationSupported: false,
      next_offset: null,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://backend.test/api/v2/projects',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ Authorization: 'Bearer test-token' }),
      }),
    );
  });

  it('список проектов нового сервера (объект с пагинацией) — нормализуется', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ projects: [{ id: 'p1' }], total: 7, offset: 0, limit: 100, next_offset: 100 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await makeClient().listProjects();

    expect(result).toEqual({
      projects: [{ id: 'p1' }],
      total: 7,
      paginationSupported: true,
      next_offset: 100,
    });
  });

  it('listProjects: limit/offset уходят в query', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ projects: [], total: 0, offset: 20, limit: 10, next_offset: null }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await makeClient().listProjects({ limit: 10, offset: 20 });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://backend.test/api/v2/projects?limit=10&offset=20',
      expect.anything(),
    );
    expect(result.next_offset).toBeNull();
  });

  it('без токена не шлёт Authorization', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ authenticated: false, oidc_enabled: true }));
    vi.stubGlobal('fetch', fetchMock);

    await makeClient({ getToken: async () => null }).getAuthStatus();

    const [, init] = fetchMock.mock.calls[0]!;
    expect((init as RequestInit).headers).not.toHaveProperty('Authorization');
  });

  it('401 → RemoteError(UNAUTHORIZED)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      jsonResponse({ error: { code: 'UNAUTHORIZED', message: 'Не авторизован' } }, 401),
    ));

    const err = await makeClient().listProjects().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RemoteError);
    expect((err as RemoteError).code).toBe('UNAUTHORIZED');
  });

  it('сетевой сбой → RemoteError(OFFLINE)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    const err = await makeClient().listProjects().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RemoteError);
    expect((err as RemoteError).code).toBe('OFFLINE');
  });

  it('HTTP 500 с телом ошибки → RemoteError(HTTP_500) и сообщение из {error.message}', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      jsonResponse({ error: { message: 'Внутренняя ошибка' } }, 500),
    ));

    const err = await makeClient().listProjects().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RemoteError);
    expect((err as RemoteError).code).toBe('HTTP_500');
    expect((err as RemoteError).message).toContain('Внутренняя ошибка');
  });

  it('allowHttpError: true → возвращает Response 400 с телом (без RemoteError)', async () => {
    const errorBody = {
      error: {
        code: 'MODEL_DISABLED',
        message: 'Модель отключена',
        details: { provider: 'p', model: 'm' },
      },
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(errorBody, 400)));

    const res = await makeClient().promptSession('s1', {}, { allowHttpError: true });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(errorBody);
  });

  it('без allowHttpError promptSession по-прежнему бросает RemoteError(HTTP_400)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      jsonResponse({ error: { code: 'MODEL_DISABLED', message: 'Модель отключена' } }, 400),
    ));

    const err = await makeClient().promptSession('s1', {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RemoteError);
    expect((err as RemoteError).code).toBe('HTTP_400');
  });

  it('401 бросает UNAUTHORIZED даже при allowHttpError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      jsonResponse({ error: { code: 'UNAUTHORIZED', message: 'Не авторизован' } }, 401),
    ));

    const err = await makeClient()
      .promptSession('s1', {}, { allowHttpError: true })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RemoteError);
    expect((err as RemoteError).code).toBe('UNAUTHORIZED');
  });

  it('таймаут → RemoteError(OFFLINE)', async () => {
    vi.stubGlobal('fetch', hangingFetchMock());

    const err = await makeClient({ timeoutMs: 50 }).listProjects().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RemoteError);
    expect((err as RemoteError).code).toBe('OFFLINE');
  });

  it('POST: createSession сериализует body и шлёт JSON', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 's1' }));
    vi.stubGlobal('fetch', fetchMock);

    await makeClient().createSession({ name: 'Новая сессия', project_id: 'p1' });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://backend.test/api/v2/sessions',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ name: 'Новая сессия', project_id: 'p1' }),
        headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
      }),
    );
  });

  it('listSessions добавляет project_id в query', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([]));
    vi.stubGlobal('fetch', fetchMock);

    await makeClient().listSessions('p 1');

    expect(fetchMock).toHaveBeenCalledWith(
      'http://backend.test/api/v2/sessions?project_id=p%201',
      expect.anything(),
    );
  });

  it('listSessions: объектный контракт (пагинация) нормализуется в RemoteSessionList', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      sessions: [{ id: 's1' }, { id: 's2' }],
      total: 7,
      offset: 0,
      limit: 2,
      next_offset: 2,
    })));

    const list = await makeClient().listSessions();

    expect(list.sessions).toHaveLength(2);
    expect(list.total).toBe(7);
    expect(list.paginationSupported).toBe(true);
    expect(list.next_offset).toBe(2);
  });

  it('listSessions: старый формат (массив) → sessions=[…], пагинация не поддерживается', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse([{ id: 's1' }])));

    const list = await makeClient().listSessions();

    expect(list.sessions).toHaveLength(1);
    expect(list.total).toBe(1);
    expect(list.paginationSupported).toBe(false);
    expect(list.next_offset).toBeNull();
  });

  it('listSessions: limit/offset уходят в query вместе с project_id', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([]));
    vi.stubGlobal('fetch', fetchMock);

    await makeClient().listSessions('p1', { limit: 50, offset: 100 });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://backend.test/api/v2/sessions?project_id=p1&limit=50&offset=100',
      expect.anything(),
    );
  });

  it('listAllProjects: обход страниц до next_offset=null', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ projects: [{ id: 'p1' }], total: 2, offset: 0, limit: 500, next_offset: 1 }))
      .mockResolvedValueOnce(jsonResponse({ projects: [{ id: 'p2' }], total: 2, offset: 1, limit: 500, next_offset: null }));
    vi.stubGlobal('fetch', fetchMock);

    const all = await makeClient().listAllProjects();

    expect(all.items.map((p) => p.id)).toEqual(['p1', 'p2']);
    expect(all.total).toBe(2);
    expect(all.truncated).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]![0]).toBe('http://backend.test/api/v2/projects?limit=500&offset=0');
    expect(fetchMock.mock.calls[1]![0]).toBe('http://backend.test/api/v2/projects?limit=500&offset=1');
  });

  it('listAllProjects: старый сервер (массив) — один вызов, список полный', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([{ id: 'p1' }, { id: 'p2' }]));
    vi.stubGlobal('fetch', fetchMock);

    const all = await makeClient().listAllProjects();

    expect(all.items).toHaveLength(2);
    expect(all.total).toBe(2);
    expect(all.truncated).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('listAllProjects: кап страниц → truncated=true (список неполон)', async () => {
    // Сервер всегда отдаёт курсор дальше — обход упирается в cap.
    const fetchMock = vi.fn().mockImplementation(async (url: string | URL) => {
      const offset = Number(new URL(String(url)).searchParams.get('offset') ?? '0');
      return jsonResponse({
        projects: [{ id: `p${offset}` }],
        total: 1000,
        offset,
        limit: 500,
        next_offset: offset + 1,
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const all = await makeClient().listAllProjects({ maxPages: 3 });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(all.truncated).toBe(true);
    expect(all.items).toHaveLength(3);
  });

  it('listAllProjects: недвижущийся курсор → truncated=true (без бесконечного цикла)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ projects: [{ id: 'p' }], total: 10, offset: 0, limit: 500, next_offset: 0 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const all = await makeClient().listAllProjects();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(all.truncated).toBe(true);
  });

  it('listAllSessions: фильтр по проекту сохраняется на всех страницах', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ sessions: [{ id: 's1' }], total: 2, offset: 0, limit: 500, next_offset: 1 }))
      .mockResolvedValueOnce(jsonResponse({ sessions: [{ id: 's2' }], total: 2, offset: 1, limit: 500, next_offset: null }));
    vi.stubGlobal('fetch', fetchMock);

    const all = await makeClient().listAllSessions('p1');

    expect(all.items.map((s) => s.id)).toEqual(['s1', 's2']);
    expect(all.truncated).toBe(false);
    expect(fetchMock.mock.calls[0]![0]).toBe('http://backend.test/api/v2/sessions?project_id=p1&limit=500&offset=0');
    expect(fetchMock.mock.calls[1]![0]).toBe('http://backend.test/api/v2/sessions?project_id=p1&limit=500&offset=1');
  });

  it('getSessionMessages пробрасывает limit/before в query', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ messages: [], session_id: 's1' }));
    vi.stubGlobal('fetch', fetchMock);

    await makeClient().getSessionMessages('s1', { limit: 50, before: 12 });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://backend.test/api/v2/sessions/s1/messages?limit=50&before=12',
      expect.anything(),
    );
  });

  it('getSessionMessages: нормализует ответ (страница) и голый массив', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      messages: [{ id: 'm1', seq: 1 }],
      session_id: 's1',
      has_more: true,
      next_before: 1,
    })));
    const page = await makeClient().getSessionMessages('s1');
    expect(page).toEqual({
      messages: [{ id: 'm1', seq: 1 }],
      session_id: 's1',
      has_more: true,
      next_before: 1,
    });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse([{ id: 'm1', seq: 1 }])));
    const legacy = await makeClient().getSessionMessages('s1');
    expect(legacy.messages).toHaveLength(1);
    expect(legacy.has_more).toBeUndefined();
  });

  it('getAuthStatus возвращает структуру /auth/status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      authenticated: true,
      oidc_enabled: true,
      user: { id: 'u1', username: 'admin', roles: ['ADMIN'] },
    })));

    const status = await makeClient().getAuthStatus();
    expect(status).toEqual({
      authenticated: true,
      oidc_enabled: true,
      user: { id: 'u1', username: 'admin', roles: ['ADMIN'] },
    });
  });

  it('listModels переносит полные метаданные моделей (контекст, цены, default)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      // Контракт каталога — страница `{models, total, offset, limit, next_offset}`.
      models: [
        {
          id: 'itphx/local.qwen3:14b', name: 'local.qwen3:14b', provider: 'itphx',
          description: 'Qwen', enabled: true, isDefault: true,
          contextWindow: 32_768, contextSource: 'api', maxOutputTokens: 4096,
          inputPrice: 1.5, outputPrice: 2.5, cacheReadPrice: 0.5, cacheWritePrice: 1,
        },
        {
          id: 'ollama/llama3', name: 'llama3', provider: 'ollama',
          description: '', enabled: false,
        },
      ],
      total: 2,
      offset: 0,
      limit: 500,
      next_offset: null,
    }));
    vi.stubGlobal('fetch', fetchMock);

    const models = await makeClient().listModels();
    expect(models).toEqual([
      {
        id: 'itphx/local.qwen3:14b', name: 'local.qwen3:14b', provider: 'itphx',
        description: 'Qwen', enabled: true, isDefault: true,
        contextWindow: 32_768, contextSource: 'api', maxOutputTokens: 4096,
        inputPrice: 1.5, outputPrice: 2.5, cacheReadPrice: 0.5, cacheWritePrice: 1,
      },
      {
        id: 'ollama/llama3', name: 'llama3', provider: 'ollama',
        description: '', enabled: false, isDefault: false,
        contextWindow: undefined, contextSource: undefined, maxOutputTokens: undefined,
        inputPrice: undefined, outputPrice: undefined, cacheReadPrice: undefined, cacheWritePrice: undefined,
      },
    ]);
    // Запрашивается максимальная страница — каталог должен быть виден целиком.
    expect(fetchMock).toHaveBeenCalledWith(
      'http://backend.test/api/v2/models?limit=500',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('listModels понимает legacy-форму групп (старый сервер)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      groups: [
        {
          provider: { name: 'itphx', type: 'openai' },
          models: [{ id: 'itphx/m1', name: 'm1', provider: 'itphx', enabled: true }],
        },
      ],
    }));
    vi.stubGlobal('fetch', fetchMock);

    const models = await makeClient().listModels();
    expect(models.map((m) => m.id)).toEqual(['itphx/m1']);
  });

  it('listProviders возвращает провайдеров сервера и шлёт Bearer', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      providers: [
        { name: 'itphx', type: 'openai', url: 'http://ai.itphx.ru/v1', model: 'local.qwen3:14b', enabled: true, is_default: true },
        { name: 'ollama', type: 'ollama', url: 'http://owu.itphx.loc:11434', model: '', enabled: true, is_default: false },
        { name: '__service', type: 'openai', url: '', model: '', enabled: true, is_default: false },
      ],
      default_provider: 'itphx',
    }));
    vi.stubGlobal('fetch', fetchMock);

    const providers = await makeClient().listProviders();
    expect(providers).toEqual([
      {
        name: 'itphx', type: 'openai', url: 'http://ai.itphx.ru/v1', model: 'local.qwen3:14b',
        enabled: true, is_default: true,
      },
      {
        name: 'ollama', type: 'ollama', url: 'http://owu.itphx.loc:11434', model: '',
        enabled: true, is_default: false,
      },
      {
        name: '__service', type: 'openai', url: '', model: '', enabled: true, is_default: false,
      },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://backend.test/api/v2/providers',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ Authorization: 'Bearer test-token' }),
      }),
    );
  });

  it('isReachable: /health ok → true', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ status: 'healthy' })));
    expect(await makeClient().isReachable()).toBe(true);
  });

  it('isReachable: сетевая ошибка → false', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    expect(await makeClient().isReachable()).toBe(false);
  });
});

describe('RemoteBackendClient × ADR-094 (метрики запросов)', () => {
  it('onRequest в finally: method/path/status/durationMs, op — нормализованный', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse([{ id: 's1' }])));
    const registry = new MetricsRegistry();
    const hooks = attachHybridMetrics(registry, () => true);
    const onRequest = vi.fn(hooks.onRequest);
    const client = makeClient({ onRequest });

    await client.listSessions('proj-1');

    expect(onRequest).toHaveBeenCalledOnce();
    expect(onRequest).toHaveBeenCalledWith(expect.objectContaining({
      method: 'GET',
      path: '/api/v2/sessions?project_id=proj-1',
      status: 200,
      durationMs: expect.any(Number),
    }));

    // Id/query не влияют на op — кардинальность ограничена.
    const text = registry.render().text;
    expect(text).toContain('synth_remote_request_duration_seconds_count{op="sessions"} 1');
    expect(text).not.toContain('proj-1');
  });

  it('onRequest при ошибке: error заполнен, запрос пробрасывается', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const onRequest = vi.fn();
    const client = makeClient({ onRequest });

    await expect(client.listSessions()).rejects.toBeInstanceOf(RemoteError);
    expect(onRequest).toHaveBeenCalledOnce();
    expect(onRequest.mock.calls[0]![0]).toMatchObject({
      method: 'GET',
      path: '/api/v2/sessions',
      error: expect.stringContaining('Сервер недоступен'),
    });
  });
});

describe('RemoteBackendClient.permissionReply (гибрид)', () => {
  it('POST на /permissions/:approvalId с телом и разбором статуса', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ status: 'ok', action: 'allow' }, 200),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await makeClient().permissionReply('rs 1', 'ap/1', {
      action: 'allow',
      once: false,
      turn_id: 'turn-1',
      digest: 'd-1',
    });

    expect(result).toEqual({ status: 200, body: { status: 'ok', action: 'allow' } });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://backend.test/api/v2/sessions/rs%201/permissions/ap%2F1',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify({ action: 'allow', once: false, turn_id: 'turn-1', digest: 'd-1' }),
      }),
    );
  });

  it('4xx не бросает: возвращает status и тело (allowHttpError)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ error: { code: 'APPROVAL_DENIED', message: 'нет гранта' } }, 403),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await makeClient().permissionReply('rs-1', 'ap-1', { action: 'deny' });

    expect(result.status).toBe(403);
    expect(result.body).toEqual({ error: { code: 'APPROVAL_DENIED', message: 'нет гранта' } });
  });

  it('не-JSON тело ошибки → body null (статус сохраняется)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('boom', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await makeClient().permissionReply('rs-1', 'ap-1', { action: 'hold' });

    expect(result).toEqual({ status: 500, body: null });
  });

  it('401 по-прежнему UNAUTHORIZED (allowHttpError не переопределяет auth)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, 401)));

    await expect(
      makeClient().permissionReply('rs-1', 'ap-1', { action: 'allow' }),
    ).rejects.toBeInstanceOf(RemoteError);
  });
});
