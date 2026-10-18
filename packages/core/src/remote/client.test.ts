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

    expect(result).toEqual([{ id: 'p1', name: 'Проект' }]);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://backend.test/api/v2/projects',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ Authorization: 'Bearer test-token' }),
      }),
    );
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
      groups: [
        {
          provider: { name: 'itphx', type: 'openai' },
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
        },
      ],
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
    expect(fetchMock).toHaveBeenCalledWith(
      'http://backend.test/api/v2/models',
      expect.objectContaining({ method: 'GET' }),
    );
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
