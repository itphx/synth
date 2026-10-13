import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WebSocket } from 'ws';
import { createStandaloneApp, injectRemoteProvider } from './app.js';
import { createLocalAuth, type ServerUserPayload } from '../auth/local.js';
import { JsonStore } from '../storage/json-store.js';
import { clearRemoteTokenProviders } from '../providers/remote.js';
import type { ModelConfig, ProviderConfig } from '@itphx/synth-shared';

// Реестр профилей изолируем: getHybridStatus/GET /hybrid/status (getHybridState в
// app.ts) читают listProfiles/getLastProfile БЕЗ path — дефолтный путь увёл бы тест
// в реальный ~/.config/synth/profiles.json. Мок ведёт себя как «реестр пуст».
vi.mock('../profiles.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../profiles.js')>();
  return {
    ...actual,
    listProfiles: async () => [],
    getLastProfile: async () => null,
  };
});

const REMOTE_PROVIDER: ProviderConfig = {
  name: 'itphx',
  type: 'remote',
  baseUrl: 'https://backend.test',
  apiKey: '',
  enabled: true,
};

const BACKEND_URL = 'https://backend.test';
const SERVER_USER = { id: 'u-1', username: 'lucky', roles: ['USER'] };

interface Group {
  provider: { name: string; type: string };
  models: Array<{ id: string }>;
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

/** Что реальный backend отдаёт в GET /api/v2/providers (включённый itphx). */
function defaultProvidersBody(): unknown {
  return {
    providers: [
      {
        name: 'itphx', type: 'openai', url: 'https://ai.itphx.ru/v1',
        model: 'm1', enabled: true, is_default: true,
      },
    ],
    default_provider: 'itphx',
  };
}

/**
 * fetch-роутер runtime-подключения: /auth/status (пользователь), /api/v2/providers
 * (зеркалируемые провайдеры) и /api/v2/models (модели сервера) нужны самому
 * connectRemoteWithApiKey+applyConnected; остальные URL уходят в onOther.
 */
function hybridFetchMock(opts: {
  modelsBody?: unknown;
  providersBody?: unknown;
  onOther?: (url: string, init?: RequestInit) => Response | Promise<Response>;
}) {
  const { modelsBody, providersBody, onOther } = opts;
  return vi.fn((url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.includes('/auth/status')) {
      return Promise.resolve(jsonResponse({ authenticated: true, oidc_enabled: true, user: SERVER_USER }));
    }
    if (u.includes('/api/v2/providers')) {
      return Promise.resolve(jsonResponse(providersBody ?? defaultProvidersBody()));
    }
    if (u.includes('/api/v2/models')) {
      return Promise.resolve(jsonResponse(modelsBody ?? { groups: [] }));
    }
    return Promise.resolve(onOther ? onOther(u, init) : jsonResponse({ error: 'not_found' }, 404));
  });
}

function modelsBodyWith(remoteModels: Array<Record<string, unknown>>): unknown {
  return {
    groups: [
      { provider: { name: 'itphx', type: 'openai' }, models: remoteModels },
    ],
  };
}

afterEach(() => {
  clearRemoteTokenProviders();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('injectRemoteProvider (unit)', () => {
  it('добавляет провайдера и модели в кэши, возвращает имя remote-провайдера', () => {
    const providerCache = new Map<string, ProviderConfig>();
    const modelCache = new Map<string, ModelConfig>();

    const name = injectRemoteProvider(providerCache, modelCache, {
      provider: REMOTE_PROVIDER,
      models: [
        { id: 'remote/m1', name: 'm1', provider: 'itphx', enabled: true },
        { id: 'remote/m2', name: 'm2', provider: 'itphx', enabled: true },
      ],
      getToken: async () => 'tok',
    });

    expect(name).toBe('itphx');
    expect(providerCache.get('itphx')).toMatchObject({
      type: 'remote',
      baseUrl: 'https://backend.test',
      enabled: true,
    });
    expect(modelCache.get('remote/m1')).toBeDefined();
    expect(modelCache.get('remote/m2')).toBeDefined();
  });

  it('без remoteProvider — ничего не меняет', () => {
    const providerCache = new Map<string, ProviderConfig>();
    const modelCache = new Map<string, ModelConfig>();
    expect(injectRemoteProvider(providerCache, modelCache, undefined)).toBeUndefined();
    expect(providerCache.size).toBe(0);
    expect(modelCache.size).toBe(0);
  });
});

describe('createStandaloneApp: remote-модели через runtime-подключение', () => {
  it('после connectRemoteWithApiKey GET /api/v2/models форвардится на backend (прокси); в JsonStore ничего не пишется', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'synth-app-remote-'));
    try {
      const fetchMock = hybridFetchMock({
        modelsBody: modelsBodyWith([
          { id: 'remote/m1', name: 'm1', provider: 'itphx', description: '', enabled: true },
        ]),
      });
      vi.stubGlobal('fetch', fetchMock);

      const handle = await createStandaloneApp({
        port: 0,
        dataDir: dir,
        apiKey: 'test-key',
        defaultBackendUrl: BACKEND_URL,
        remoteLlm: 'server',
      });
      await handle.connectRemoteWithApiKey(BACKEND_URL, 'tok');

      const res = await handle.app.request('/api/v2/models', { headers: { Authorization: 'Bearer test-key' } });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { groups: Group[] };
      const group = body.groups.find((g) => g.provider.name === 'itphx');
      expect(group).toBeDefined();
      expect(group!.models.map((m) => m.id)).toEqual(['remote/m1']);

      // Инъекция — только in-memory: в store ничего не записано.
      const modelStore = new JsonStore<ModelConfig>({ dataDir: dir, subdir: 'models' });
      expect(await modelStore.exists('remote/m1')).toBe(false);
      const providerStore = new JsonStore<ProviderConfig>({ dataDir: dir, subdir: 'providers' });
      expect(await providerStore.exists('itphx')).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('без подключения — поведение не изменилось (remote-группы нет)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'synth-app-remote-none-'));
    try {
      const { app } = await createStandaloneApp({ port: 0, dataDir: dir, apiKey: 'test-key' });
      const res = await app.request('/api/v2/models', { headers: { Authorization: 'Bearer test-key' } });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { groups: Group[] };
      expect(body.groups.find((g) => g.provider.name === 'itphx')).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('disconnectRemote убирает remote-провайдера/модели и сбрасывает гибрид-статус', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'synth-app-remote-disc-'));
    try {
      const fetchMock = hybridFetchMock({
        modelsBody: modelsBodyWith([
          { id: 'remote/m1', name: 'm1', provider: 'itphx', description: '', enabled: true },
        ]),
      });
      vi.stubGlobal('fetch', fetchMock);

      const handle = await createStandaloneApp({
        port: 0,
        dataDir: dir,
        apiKey: 'test-key',
        defaultBackendUrl: BACKEND_URL,
        remoteLlm: 'server',
      });
      await handle.connectRemoteWithApiKey(BACKEND_URL, 'tok');
      expect((await handle.getHybridStatus()).connected).toBe(true);

      await handle.disconnectRemote();

      const status = await handle.getHybridStatus();
      expect(status.connected).toBe(false);
      expect(status.backendUrl).toBeNull();
      const res = await handle.app.request('/api/v2/models', { headers: { Authorization: 'Bearer test-key' } });
      const body = (await res.json()) as { groups: Group[] };
      expect(body.groups.find((g) => g.provider.name === 'itphx')).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('disconnectRemote восстанавливает локального провайдера, перекрытого зеркалом', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'synth-app-remote-restore-'));
    try {
      // Локальный провайдер itphx (openai) + модель — конфликтует с серверным зеркалом.
      const providerStore = new JsonStore<ProviderConfig>({ dataDir: dir, subdir: 'providers' });
      await providerStore.save('itphx', {
        name: 'itphx', type: 'openai', baseUrl: 'http://local.test', apiKey: 'k', enabled: true,
      });

      const fetchMock = hybridFetchMock({
        modelsBody: modelsBodyWith([
          { id: 'itphx/m1', name: 'm1', provider: 'itphx', description: '', enabled: true },
        ]),
      });
      vi.stubGlobal('fetch', fetchMock);

      const handle = await createStandaloneApp({
        port: 0,
        dataDir: dir,
        apiKey: 'test-key',
        defaultBackendUrl: BACKEND_URL,
        remoteLlm: 'server',
      });
      // До подключения в providerCache локальный itphx.
      await handle.connectRemoteWithApiKey(BACKEND_URL, 'tok');
      await handle.disconnectRemote();

      // Локальная сессия с itphx после отключения резолвится (зеркало откачено):
      // GET /api/v2/models не проксируется, локальная группа itphx снова видна.
      const res = await handle.app.request('/api/v2/models', { headers: { Authorization: 'Bearer test-key' } });
      const body = (await res.json()) as { groups: Group[] };
      const localGroup = body.groups.find((g) => g.provider.name === 'itphx');
      expect(localGroup).toBeDefined();
      expect(localGroup!.provider.type).toBe('openai');
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
});

describe('createStandaloneApp: зеркалирование серверных провайдеров (локальная сессия → LLM Proxy)', () => {
  function sseResponse(events: string[]): Response {
    return new Response(events.map((e) => `data: ${e}\n\n`).join(''), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  }

  it('локальная сессия резолвит зеркало itphx и шлёт запрос с provider в теле', { timeout: 20_000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'synth-app-mirror-e2e-'));
    try {
      const llmProxyCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
      const fetchMock = hybridFetchMock({
        modelsBody: modelsBodyWith([
          {
            id: 'itphx/m1', name: 'm1', provider: 'itphx', description: '', enabled: true,
            contextWindow: 16_384, inputPrice: 1, outputPrice: 2,
          },
        ]),
        onOther: (url, init) => {
          if (url.includes('/api/v2/llm/chat/completions')) {
            const rawBody = typeof init?.body === 'string' ? init.body : '';
            llmProxyCalls.push({ url, body: JSON.parse(rawBody) as Record<string, unknown> });
            return sseResponse([
              JSON.stringify({ choices: [{ index: 0, delta: { content: 'Ответ зеркала itphx' }, finish_reason: null }] }),
              JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }),
              '[DONE]',
            ]);
          }
          return jsonResponse({}, 200);
        },
      });
      vi.stubGlobal('fetch', fetchMock);

      const handle = await createStandaloneApp({
        port: 0,
        dataDir: dir,
        apiKey: 'test-key',
        defaultBackendUrl: BACKEND_URL,
        remoteLlm: 'server',
      });
      await handle.connectRemoteWithApiKey(BACKEND_URL, 'tok');

      // Локальная сессия с провайдером/моделью сервера (имя зеркала = itphx).
      const createRes = await handle.app.request('/api/v2/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-key' },
        body: JSON.stringify({
          name: 'зеркало itphx',
          settings: { provider: 'itphx', model: 'itphx/m1' },
        }),
      });
      expect(createRes.status).toBe(201);
      const ses = (await createRes.json()) as { id: string };
      expect(ses.id).toBeDefined();

      const promptRes = await handle.app.request(`/api/v2/sessions/${ses.id}/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-key' },
        body: JSON.stringify({ content: 'привет зеркалу' }),
      });
      expect(promptRes.status).toBe(200);
      const text = await promptRes.text();
      const events = text.split('\n')
        .filter((l) => l.startsWith('data: '))
        .map((l) => JSON.parse(l.slice(6)) as { type: string; data: Record<string, unknown> });
      const done = events.find((e) => e.type === 'stream.done');
      expect(done).toBeDefined();
      expect(String(done!.data.content)).toContain('Ответ зеркала itphx');

      // RemoteProvider ушёл на сервер с ЯВНЫМ provider (имя зеркала) и моделью сервера.
      const proxyCall = llmProxyCalls.find((c) => c.url.includes('/api/v2/llm/chat/completions'));
      expect(proxyCall).toBeDefined();
      expect(proxyCall!.body.provider).toBe('itphx');
      expect(proxyCall!.body.model).toBe('itphx/m1');
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('remote.llm=local: зеркало не перекрывает локального провайдера с тем же именем', { timeout: 20_000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'synth-app-mirror-local-'));
    try {
      // Локальный провайдер itphx (openai) — при remote.llm=local он не перекрывается.
      const providerStore = new JsonStore<ProviderConfig>({ dataDir: dir, subdir: 'providers' });
      await providerStore.save('itphx', {
        name: 'itphx', type: 'openai', baseUrl: 'http://local.test', apiKey: 'k', enabled: true,
      });

      const fetchMock = hybridFetchMock({
        modelsBody: modelsBodyWith([
          { id: 'itphx/m1', name: 'm1', provider: 'itphx', description: '', enabled: true },
        ]),
      });
      vi.stubGlobal('fetch', fetchMock);

      const handle = await createStandaloneApp({
        port: 0,
        dataDir: dir,
        apiKey: 'test-key',
        defaultBackendUrl: BACKEND_URL,
        remoteLlm: 'local',
      });
      await handle.connectRemoteWithApiKey(BACKEND_URL, 'tok');

      // Локальная сессия всё ещё резолвит ЛОКАЛЬНЫЙ itphx (openai) — зеркало не создано.
      const createRes = await handle.app.request('/api/v2/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-key' },
        body: JSON.stringify({
          name: 'локальный itphx',
          settings: { provider: 'itphx', model: 'itphx/m1' },
        }),
      });
      expect(createRes.status).toBe(201);

      // В remote.llm=local моделей сервера для itphx нет (провайдер перекрыт
      // локальным) — зеркало не появилось. После отключения локальная группа
      // itphx (openai) видна как раньше.
      await handle.disconnectRemote();
      const res = await handle.app.request('/api/v2/models', { headers: { Authorization: 'Bearer test-key' } });
      const body = (await res.json()) as { groups: Group[] };
      const group = body.groups.find((g) => g.provider.name === 'itphx');
      expect(group).toBeDefined();
      expect(group!.provider.type).toBe('openai');
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
});

describe('createStandaloneApp: RemoteEventBridge и /api/v2/events (runtime)', () => {
  it('после подключения /api/v2/events доставляет remote:<id> через subscribeAll', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'synth-app-bridge-'));
    const abort = new AbortController();
    try {
      const fetchMock = hybridFetchMock({
        modelsBody: modelsBodyWith([]),
        // SSE-эндпоинт backend: стрим с одним событием и закрытием.
        onOther: () => jsonResponse({}, 200),
      });
      vi.stubGlobal('fetch', fetchMock);

      const handle = await createStandaloneApp({
        port: 0,
        dataDir: dir,
        apiKey: 'test-key',
        defaultBackendUrl: BACKEND_URL,
      });
      await handle.connectRemoteWithApiKey(BACKEND_URL, 'tok');

      // Мост создан и запущен при подключении.
      expect(handle.remoteEventBridge).toBeDefined();

      const res = await handle.app.request('/api/v2/events', {
        headers: { Authorization: 'Bearer test-key' },
        signal: abort.signal,
      });
      expect(res.status).toBe(200);
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();

      // То, что сделал бы мост: публикация события удалённой сессии (remote:<id>)
      // и локальной сессии — обе доходят до UI через subscribeAll.
      handle.eventBus.publish('remote:ses-1', 'session.updated', { id: 'remote:ses-1', name: 'x' });
      handle.eventBus.publish('local-1', 'stream.chunk', { stream_id: 's1' });

      const first = await reader.read();
      expect(decoder.decode(first.value)).toContain('"sessionId":"remote:ses-1"');
      const second = await reader.read();
      expect(decoder.decode(second.value)).toContain('"sessionId":"local-1"');
    } finally {
      abort.abort();
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
});

describe('createStandaloneApp: WS /ws/events send_message с remote-рефом (runtime)', () => {
  /**
   * Открыть WS и начать собирать сообщения ДО установки соединения: сервер
   * шлёт 'connected' сразу после upgrade, поэтому listener вешаем заранее.
   */
  function connectCollecting(port: number, apiKey: string): { ws: Promise<WebSocket>; received: Array<Record<string, unknown>> } {
    const received: Array<Record<string, unknown>> = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/events`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    ws.on('message', (raw: Buffer) => {
      try { received.push(JSON.parse(raw.toString())); } catch { /* ignore */ }
    });
    const opened = new Promise<WebSocket>((resolve, reject) => {
      ws.on('open', () => resolve(ws));
      ws.on('error', reject);
    });
    return { ws: opened, received };
  }

  async function startServer(config: Record<string, unknown> = {}) {
    const dir = await mkdtemp(join(tmpdir(), 'synth-app-ws-remote-'));
    const handle = await createStandaloneApp({
      port: 0,
      dataDir: dir,
      apiKey: 'test-key',
      ...config,
    });
    await new Promise<void>((resolve) => handle.server.listen(0, resolve));
    const address = handle.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    return {
      dir,
      handle,
      server: handle.server,
      port,
      close: async () => {
        await handle.disconnectRemote?.().catch(() => {});
        await new Promise<void>((resolve) => handle.server.close(() => resolve()));
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      },
    };
  }

  it('remote:<id>: промпт уходит на backend (fetch), локальный оркестратор не трогается', async () => {
    const fetchMock = hybridFetchMock({
      modelsBody: modelsBodyWith([]),
      onOther: (url, init) => {
        if (url.includes('/prompt')) {
          expect(init?.method).toBe('POST');
          return jsonResponse({ ok: true });
        }
        return jsonResponse({}, 200);
      },
    });
    vi.stubGlobal('fetch', fetchMock);

    const app = await startServer({ defaultBackendUrl: BACKEND_URL });
    await app.handle.connectRemoteWithApiKey(BACKEND_URL, 'tok');
    const { ws: wsP, received } = connectCollecting(app.port, 'test-key');
    const ws = await wsP;

    try {
      await vi.waitFor(() => {
        expect(received.some((m) => m.type === 'connected')).toBe(true);
      }, { timeout: 5000 });

      ws.send(JSON.stringify({
        type: 'send_message',
        session_id: 'remote:ses-1',
        content: 'привет удалённой сессии',
        agent_role: 'developer',
        model: 'remote/m1',
      }));

      await vi.waitFor(() => {
        const promptCall = fetchMock.mock.calls.find(([u]) => String(u).includes('/api/v2/sessions/ses-1/prompt'));
        expect(promptCall).toBeDefined();
      }, { timeout: 5000 });

      // Промпт ушёл на backend с локальным id (без префикса) и текстом.
      const promptCall = fetchMock.mock.calls.find(([u]) => String(u).includes('/api/v2/sessions/ses-1/prompt'))!;
      const [url, init] = promptCall;
      expect(String(url)).toBe(`${BACKEND_URL}/api/v2/sessions/ses-1/prompt`);
      const rawBody = init?.body;
      const sentBody = typeof rawBody === 'string'
        ? (JSON.parse(rawBody) as Record<string, unknown>)
        : (JSON.parse(new TextDecoder().decode(rawBody as ArrayBuffer)) as Record<string, unknown>);
      expect(sentBody.content).toBe('привет удалённой сессии');
      expect(sentBody.agent).toBe('developer');
      expect(sentBody.model).toBe('remote/m1');

      // UI сначала получил queued, ошибки «Session not found» нет.
      await vi.waitFor(() => {
        expect(received.some((m) => m.type === 'queued' && m.session_id === 'remote:ses-1')).toBe(true);
      }, { timeout: 5000 });
      expect(received.some((m) => m.type === 'error')).toBe(false);
    } finally {
      ws.close();
      await app.close();
    }
  });

  it('remote:<id> без подключения → error «Удалённый сервер не подключён»', async () => {
    const app = await startServer({});
    const { ws: wsP, received } = connectCollecting(app.port, 'test-key');
    const ws = await wsP;

    try {
      // Ждём handshake-сообщение connected: сервер зарегистрировал on('message').
      await vi.waitFor(() => {
        expect(received.some((m) => m.type === 'connected')).toBe(true);
      }, { timeout: 5000 });

      ws.send(JSON.stringify({
        type: 'send_message',
        session_id: 'remote:ses-1',
        content: 'привет',
      }));

      await vi.waitFor(() => {
        expect(received.some((m) => m.type === 'error' && (m.data as Record<string, unknown> | undefined)?.error === 'Удалённый сервер не подключён')).toBe(true);
      }, { timeout: 5000 });
    } finally {
      ws.close();
      await app.close();
    }
  });

  it('ошибка backend на prompt → WS error в формате локальных ошибок', async () => {
    const fetchMock = hybridFetchMock({
      modelsBody: modelsBodyWith([]),
      onOther: (url) => {
        if (url.includes('/prompt')) {
          return jsonResponse({ error: { code: 'RATE_LIMITED', message: 'HTTP 429 (remote)' } }, 429);
        }
        return jsonResponse({}, 200);
      },
    });
    vi.stubGlobal('fetch', fetchMock);

    const app = await startServer({ defaultBackendUrl: BACKEND_URL });
    await app.handle.connectRemoteWithApiKey(BACKEND_URL, 'tok');
    const { ws: wsP, received } = connectCollecting(app.port, 'test-key');
    const ws = await wsP;

    try {
      await vi.waitFor(() => {
        expect(received.some((m) => m.type === 'connected')).toBe(true);
      }, { timeout: 5000 });

      ws.send(JSON.stringify({
        type: 'send_message',
        session_id: 'remote:ses-1',
        content: 'привет',
      }));

      await vi.waitFor(() => {
        const hasHttp429 = received.some(
          (m) => m.type === 'error'
            && String((m.data as Record<string, unknown> | undefined)?.error).includes('HTTP 429'),
        );
        expect(hasHttp429).toBe(true);
      }, { timeout: 5000 });
    } finally {
      ws.close();
      await app.close();
    }
  });
});

describe('createStandaloneApp: WS /ws/events аутентификация через cookie v2 (server-identity)', () => {
  function collect(ws: WebSocket): Array<Record<string, unknown>> {
    const received: Array<Record<string, unknown>> = [];
    ws.on('message', (raw: Buffer) => {
      try { received.push(JSON.parse(raw.toString())); } catch { /* ignore */ }
    });
    return received;
  }

  /**
   * Открыть WS и начать собирать сообщения ДО установки соединения: сервер
   * шлёт 'connected' сразу после upgrade (после `await listSessions`), поэтому
   * listener вешаем заранее — иначе кадр может прийти между 'open' и подпиской
   * и потеряться (ws не буферизует пропущенные message).
   */
  function connectCollecting(
    port: number,
    headers: Record<string, string>,
  ): { ws: Promise<WebSocket>; received: Array<Record<string, unknown>> } {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/events`, { headers });
    const received = collect(ws);
    const opened = new Promise<WebSocket>((resolve, reject) => {
      ws.on('open', () => resolve(ws));
      ws.on('error', reject);
    });
    return { ws: opened, received };
  }

  async function startServer() {
    const dir = await mkdtemp(join(tmpdir(), 'synth-app-ws-cookie-'));
    const handle = await createStandaloneApp({
      port: 0,
      dataDir: dir,
      apiKey: 'test-key',
    });
    await new Promise<void>((resolve) => handle.server.listen(0, resolve));
    const address = handle.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    return {
      dir,
      handle,
      server: handle.server,
      port,
      close: async () => {
        await handle.disconnectRemote?.().catch(() => {});
        await new Promise<void>((resolve) => handle.server.close(() => resolve()));
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      },
    };
  }

  /** Собрать подписанную server-identity cookie v2 через setServerUserCookie. */
  function makeServerCookie(apiKey: string, user: ServerUserPayload): string {
    let setCookie = '';
    const auth = createLocalAuth({ apiKey });
    auth.setServerUserCookie({
      req: { header: () => undefined },
      header: (name: string, value: string) => {
        if (name === 'Set-Cookie') setCookie = value;
      },
    } as unknown as Parameters<typeof auth.setServerUserCookie>[0], user);
    return setCookie.split(';')[0]!;
  }

  it('server-identity cookie v2 → соединение принимается (connected)', async () => {
    const app = await startServer();
    const cookie = makeServerCookie('test-key', { id: 'u-1', username: 'lucky', roles: ['USER'] });

    const { ws: wsP, received } = connectCollecting(app.port, { Cookie: cookie });
    const ws = await wsP;

    try {
      await vi.waitFor(() => {
        expect(received.some((m) => m.type === 'connected')).toBe(true);
      }, { timeout: 5000 });
    } finally {
      ws.close();
      await app.close();
    }
  });

  it('Bearer API-ключ по-прежнему работает (CLI/API)', async () => {
    const app = await startServer();
    const { ws: wsP, received } = connectCollecting(app.port, { Authorization: 'Bearer test-key' });
    const ws = await wsP;

    try {
      await vi.waitFor(() => {
        expect(received.some((m) => m.type === 'connected')).toBe(true);
      }, { timeout: 5000 });
    } finally {
      ws.close();
      await app.close();
    }
  });

  it('невалидная cookie / без авторизации → 401', async () => {
    const app = await startServer();
    try {
      const result = await new Promise<{ status?: number }>((resolve) => {
        const s = new WebSocket(`ws://127.0.0.1:${app.port}/ws/events`, {
          headers: { Cookie: 'synth_session=invalid' },
        });
        s.on('unexpected-response', (_req, res) => resolve({ status: res.statusCode }));
        s.on('open', () => resolve({}));
        s.on('error', () => resolve({}));
      });
      expect(result.status).toBe(401);
    } finally {
      await app.close();
    }
  });
});

describe('createStandaloneApp: HTTP-эндпоинты переноса проектов смонтированы (publish/fork-local)', () => {
  it('без runtime-подключения publish → 502 REMOTE_UNAVAILABLE', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'synth-app-transfer-mount-'));
    try {
      const { app } = await createStandaloneApp({ port: 0, dataDir: dir, apiKey: 'test-key' });
      const res = await app.request('/api/v2/projects/local-proj/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-key' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(502);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('REMOTE_UNAVAILABLE');
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('без runtime-подключения fork-local → 502 REMOTE_UNAVAILABLE', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'synth-app-transfer-mount-'));
    try {
      const { app } = await createStandaloneApp({ port: 0, dataDir: dir, apiKey: 'test-key' });
      const res = await app.request('/api/v2/projects/remote:abc/fork-local', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-key' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(502);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('REMOTE_UNAVAILABLE');
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
});

describe('createStandaloneApp: гибрид-статус и oidc_enabled (адрес не задан)', () => {
  it('гибрид включён, адрес не задан (hybridEnabled) → /hybrid/status enabled:true, serverConfigured:false; /auth/status oidc_enabled:true', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'synth-app-hybrid-addrnone-'));
    try {
      const { app } = await createStandaloneApp({
        port: 0,
        dataDir: dir,
        apiKey: 'test-key',
        // remote.enabled:true, но БЕЗ defaultBackendUrl/issuer/подключения.
        hybridEnabled: true,
      });

      const hybridRes = await app.request('/api/v2/hybrid/status');
      expect(hybridRes.status).toBe(200);
      expect(await hybridRes.json()).toMatchObject({ enabled: true, connected: false, serverConfigured: false });

      const authRes = await app.request('/auth/status');
      expect(authRes.status).toBe(200);
      expect(((await authRes.json()) as { oidc_enabled: boolean }).oidc_enabled).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('без гибрида (нет hybridEnabled/адреса/подключения) → /hybrid/status enabled:false; /auth/status oidc_enabled:false', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'synth-app-nohybrid-'));
    try {
      const { app } = await createStandaloneApp({ port: 0, dataDir: dir, apiKey: 'test-key' });

      const hybridRes = await app.request('/api/v2/hybrid/status');
      expect(hybridRes.status).toBe(200);
      expect(await hybridRes.json()).toMatchObject({ enabled: false, connected: false, serverConfigured: false });

      const authRes = await app.request('/auth/status');
      expect(authRes.status).toBe(200);
      expect(((await authRes.json()) as { oidc_enabled: boolean }).oidc_enabled).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('managed/без standalone не затрагивается: defaultBackendUrl задан → serverConfigured:true, oidc_enabled:true (поле адреса скрыто)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'synth-app-hybrid-addrknown-'));
    try {
      const { app } = await createStandaloneApp({
        port: 0,
        dataDir: dir,
        apiKey: 'test-key',
        defaultBackendUrl: BACKEND_URL,
      });

      const hybridRes = await app.request('/api/v2/hybrid/status');
      expect(hybridRes.status).toBe(200);
      expect(await hybridRes.json()).toMatchObject({ enabled: true, serverConfigured: true });

      const authRes = await app.request('/auth/status');
      expect(authRes.status).toBe(200);
      expect(((await authRes.json()) as { oidc_enabled: boolean }).oidc_enabled).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
});

describe('createStandaloneApp: SSE /api/v2/events (standalone, subscribeAll)', () => {
  it('доставляет событие сессии, созданной ПОСЛЕ подключения подписчика (AD-089)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'synth-app-sse-standalone-'));
    const abort = new AbortController();
    try {
      const handle = await createStandaloneApp({ port: 0, dataDir: dir, apiKey: 'test-key' });

      // Подписчик (внешний add-on) подключается до появления сессии.
      const res = await handle.app.request('/api/v2/events', {
        headers: { Authorization: 'Bearer test-key' },
        signal: abort.signal,
      });
      expect(res.status).toBe(200);
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();

      // Сессия создана позже (аналог events-funnel: auto-bind/ephemeral во время
      // работы add-on'а). Per-session subscribe терял такие события — subscribeAll
      // обязан доставить.
      handle.eventBus.publish('ses-after-connect', 'stream.done', { ok: true });

      const chunk = await reader.read();
      const payload = decoder.decode(chunk.value);
      expect(payload).toContain('"sessionId":"ses-after-connect"');
      expect(payload).toContain('"stream.done"');
    } finally {
      abort.abort();
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
});
