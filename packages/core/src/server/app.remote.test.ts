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

const REMOTE_PROVIDER: ProviderConfig = {
  name: 'synth-remote',
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

/**
 * fetch-роутер runtime-подключения: /auth/status (пользователь) и /api/v2/models
 * (модели сервера) нужны самому connectRemoteWithApiKey+applyConnected; остальные
 * URL уходят в onOther.
 */
function hybridFetchMock(opts: {
  modelsBody?: unknown;
  onOther?: (url: string, init?: RequestInit) => Response | Promise<Response>;
}) {
  const { modelsBody, onOther } = opts;
  return vi.fn((url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.includes('/auth/status')) {
      return Promise.resolve(jsonResponse({ authenticated: true, oidc_enabled: true, user: SERVER_USER }));
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
      { provider: { name: 'synth-remote', type: 'remote' }, models: remoteModels },
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
        { id: 'remote/m1', name: 'm1', provider: 'synth-remote', enabled: true },
        { id: 'remote/m2', name: 'm2', provider: 'synth-remote', enabled: true },
      ],
      getToken: async () => 'tok',
    });

    expect(name).toBe('synth-remote');
    expect(providerCache.get('synth-remote')).toMatchObject({
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
          { id: 'remote/m1', name: 'm1', provider: 'synth-remote', description: '', enabled: true },
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
      const group = body.groups.find((g) => g.provider.name === 'synth-remote');
      expect(group).toBeDefined();
      expect(group!.models.map((m) => m.id)).toEqual(['remote/m1']);

      // Инъекция — только in-memory: в store ничего не записано.
      const modelStore = new JsonStore<ModelConfig>({ dataDir: dir, subdir: 'models' });
      expect(await modelStore.exists('remote/m1')).toBe(false);
      const providerStore = new JsonStore<ProviderConfig>({ dataDir: dir, subdir: 'providers' });
      expect(await providerStore.exists('synth-remote')).toBe(false);
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
      expect(body.groups.find((g) => g.provider.name === 'synth-remote')).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('disconnectRemote убирает remote-провайдера/модели и сбрасывает гибрид-статус', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'synth-app-remote-disc-'));
    try {
      const fetchMock = hybridFetchMock({
        modelsBody: modelsBodyWith([
          { id: 'remote/m1', name: 'm1', provider: 'synth-remote', description: '', enabled: true },
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
      expect(handle.getHybridStatus().connected).toBe(true);

      await handle.disconnectRemote();

      expect(handle.getHybridStatus().connected).toBe(false);
      expect(handle.getHybridStatus().backendUrl).toBeNull();
      const res = await handle.app.request('/api/v2/models', { headers: { Authorization: 'Bearer test-key' } });
      const body = (await res.json()) as { groups: Group[] };
      expect(body.groups.find((g) => g.provider.name === 'synth-remote')).toBeUndefined();
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

    const ws = await new Promise<WebSocket>((resolve, reject) => {
      const s = new WebSocket(`ws://127.0.0.1:${app.port}/ws/events`, {
        headers: { Cookie: cookie },
      });
      s.on('open', () => resolve(s));
      s.on('error', reject);
    });
    const received = collect(ws);

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
    const ws = await new Promise<WebSocket>((resolve, reject) => {
      const s = new WebSocket(`ws://127.0.0.1:${app.port}/ws/events`, {
        headers: { Authorization: 'Bearer test-key' },
      });
      s.on('open', () => resolve(s));
      s.on('error', reject);
    });
    const received = collect(ws);

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
