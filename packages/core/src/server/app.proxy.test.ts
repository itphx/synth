import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createStandaloneApp } from './app.js';
import { clearRemoteTokenProviders } from '../providers/remote.js';

const BACKEND_URL = 'https://backend.test';
const API_KEY = 'admin-key';
const SERVER_USER = { id: 'u-1', username: 'lucky', roles: ['ADMIN', 'USER'] };

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

/**
 * fetch-роутер для runtime-подключения (connectRemoteWithApiKey) + проксируемых
 * запросов: /auth/status и /api/v2/models нужны самому подключению, остальные
 * URL уходят в handler теста.
 */
function apiKeyFetchRouter(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  return vi.fn((url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.includes('/auth/status')) {
      return Promise.resolve(jsonResponse({ authenticated: true, oidc_enabled: true, user: SERVER_USER }));
    }
    if (u.includes('/api/v2/models')) {
      return Promise.resolve(jsonResponse({ groups: [] }));
    }
    return Promise.resolve(handler(u, init));
  });
}

/** Поднять standalone app в гибриде и подключить его по API-ключу (runtime). */
async function makeHybridApp() {
  const dir = await mkdtemp(join(tmpdir(), 'synth-app-proxy-'));
  const handle = await createStandaloneApp({
    port: 0,
    dataDir: dir,
    apiKey: 'test-key',
    defaultBackendUrl: BACKEND_URL,
    remoteLlm: 'server',
  });
  await handle.connectRemoteWithApiKey(BACKEND_URL, API_KEY);
  return { dir, handle };
}

afterEach(() => {
  clearRemoteTokenProviders();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('createStandaloneApp: прокси серверных роутов (runtime-подключение)', () => {
  it('GET /api/v2/audit форвардится на backend с Bearer-токеном, ответ возвращается как есть', async () => {
    const fetchRouter = apiKeyFetchRouter(() => jsonResponse({
      entries: [{ id: 'a1', action: 'login' }],
    }, 200, { 'x-upstream': 'yes' }));
    vi.stubGlobal('fetch', fetchRouter);

    const { dir, handle } = await makeHybridApp();
    const { app } = handle;
    try {
      const res = await app.request('/api/v2/audit', {
        headers: { Authorization: 'Bearer test-key' },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('x-upstream')).toBe('yes');
      expect(await res.json()).toEqual({ entries: [{ id: 'a1', action: 'login' }] });

      const auditCall = fetchRouter.mock.calls.find(([u]) => String(u).includes('/api/v2/audit'))!;
      expect(auditCall).toBeDefined();
      const [url, init] = auditCall;
      expect(url).toBe(`${BACKEND_URL}/api/v2/audit`);
      expect(init!.method).toBe('GET');
      expect((init!.headers as Record<string, string>).Authorization).toBe(`Bearer ${API_KEY}`);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('query-строка и JSON-тело POST пробрасываются (POST /api/v2/llm)', async () => {
    const fetchRouter = apiKeyFetchRouter(() => jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchRouter);

    const { dir, handle } = await makeHybridApp();
    const { app } = handle;
    try {
      const res = await app.request('/api/v2/llm/chat/completions?stream=false', {
        method: 'POST',
        headers: { Authorization: 'Bearer test-key', 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'm1', messages: [{ role: 'user', content: 'hi' }] }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });

      const llmCall = fetchRouter.mock.calls.find(([u]) => String(u).includes('/api/v2/llm'))!;
      const [url, init] = llmCall;
      expect(url).toBe(`${BACKEND_URL}/api/v2/llm/chat/completions?stream=false`);
      expect(init!.method).toBe('POST');
      const sentBody = new TextDecoder().decode(init!.body as ArrayBuffer);
      expect(sentBody).toBe(JSON.stringify({ model: 'm1', messages: [{ role: 'user', content: 'hi' }] }));
      expect((init!.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('локальный /api/v2/settings не форвардится (next() до локального роута)', async () => {
    const fetchRouter = apiKeyFetchRouter(() => jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchRouter);

    const { dir, handle } = await makeHybridApp();
    const { app } = handle;
    try {
      const res = await app.request('/api/v2/settings/workspace', {
        headers: { Authorization: 'Bearer test-key' },
      });
      expect(res.status).toBe(200);
      const forwarded = fetchRouter.mock.calls.filter(([u]) => String(u).includes('/api/v2/settings'));
      expect(forwarded).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('401 от backend проксируется как есть, формат ошибки сохраняется', async () => {
    const fetchRouter = apiKeyFetchRouter(() => jsonResponse({
      error: { code: 'FORBIDDEN', message: 'Недостаточно прав' },
    }, 403));
    vi.stubGlobal('fetch', fetchRouter);

    const { dir, handle } = await makeHybridApp();
    const { app } = handle;
    try {
      const res = await app.request('/api/v2/audit', {
        headers: { Authorization: 'Bearer test-key' },
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: { code: 'FORBIDDEN', message: 'Недостаточно прав' } });
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('сетевая ошибка → 502 OFFLINE в формате {error:{code,message}}', async () => {
    // connectRemoteWithApiKey проходит, но проксируемые запросы падают сетью.
    const fetchRouter = apiKeyFetchRouter(() => {
      throw new TypeError('Failed to fetch');
    });
    vi.stubGlobal('fetch', fetchRouter);

    const { dir, handle } = await makeHybridApp();
    const { app } = handle;
    try {
      const res = await app.request('/api/v2/providers', {
        headers: { Authorization: 'Bearer test-key' },
      });
      expect(res.status).toBe(502);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe('OFFLINE');
      expect(body.error.message).toContain('Сервер недоступен');
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('без подключения → next(): /api/v2/audit локально отсутствует (404), fetch не вызывается', async () => {
    const fetchRouter = apiKeyFetchRouter(() => jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchRouter);

    const dir = await mkdtemp(join(tmpdir(), 'synth-app-proxy-none-'));
    try {
      const { app } = await createStandaloneApp({ port: 0, dataDir: dir, apiKey: 'test-key' });

      const res = await app.request('/api/v2/audit', {
        headers: { Authorization: 'Bearer test-key' },
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('NOT_FOUND');
      expect(fetchRouter).not.toHaveBeenCalled();
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('без подключения → /api/v2/providers работает локально (прокси не перехватывает)', async () => {
    const fetchRouter = apiKeyFetchRouter(() => jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchRouter);

    const dir = await mkdtemp(join(tmpdir(), 'synth-app-proxy-local-providers-'));
    try {
      const { app } = await createStandaloneApp({ port: 0, dataDir: dir, apiKey: 'test-key' });

      const res = await app.request('/api/v2/providers', {
        headers: { Authorization: 'Bearer test-key' },
      });
      expect(res.status).toBe(200);
      expect(fetchRouter).not.toHaveBeenCalled();
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('nested GET /api/v2/agents/:id/ssh-keys форвардится (Bearer, ответ/заголовки как есть)', async () => {
    const fetchRouter = apiKeyFetchRouter(() => jsonResponse(
      [{ id: 'k1', name: 'deploy-key' }],
      200,
      { 'x-upstream': 'yes' },
    ));
    vi.stubGlobal('fetch', fetchRouter);

    const { dir, handle } = await makeHybridApp();
    const { app } = handle;
    try {
      const res = await app.request('/api/v2/agents/a1/ssh-keys', {
        headers: { Authorization: 'Bearer test-key' },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('x-upstream')).toBe('yes');
      expect(await res.json()).toEqual([{ id: 'k1', name: 'deploy-key' }]);

      const call = fetchRouter.mock.calls.find(([u]) => String(u).includes('/api/v2/agents/a1/ssh-keys'))!;
      expect(call).toBeDefined();
      const [url, init] = call;
      expect(url).toBe(`${BACKEND_URL}/api/v2/agents/a1/ssh-keys`);
      expect(init!.method).toBe('GET');
      expect((init!.headers as Record<string, string>).Authorization).toBe(`Bearer ${API_KEY}`);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('nested POST и DELETE /api/v2/agents/:id/ssh-keys тоже форвардятся', async () => {
    const fetchRouter = apiKeyFetchRouter(() => jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchRouter);

    const { dir, handle } = await makeHybridApp();
    const { app } = handle;
    try {
      await app.request('/api/v2/agents/a1/ssh-keys', {
        method: 'POST',
        headers: { Authorization: 'Bearer test-key', 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'k', privateKey: 'KEY' }),
      });
      await app.request('/api/v2/agents/a1/ssh-keys/k1', {
        method: 'DELETE',
        headers: { Authorization: 'Bearer test-key' },
      });

      const postCall = fetchRouter.mock.calls.find(
        ([u, init]) => String(u).includes('/api/v2/agents/a1/ssh-keys') && init?.method === 'POST',
      )!;
      expect(postCall).toBeDefined();
      expect(postCall[0]).toBe(`${BACKEND_URL}/api/v2/agents/a1/ssh-keys`);
      expect((postCall[1]!.headers as Record<string, string>).Authorization).toBe(`Bearer ${API_KEY}`);

      const deleteCall = fetchRouter.mock.calls.find(
        ([u, init]) => String(u).includes('/api/v2/agents/a1/ssh-keys/k1') && init?.method === 'DELETE',
      )!;
      expect(deleteCall).toBeDefined();
      expect(deleteCall[0]).toBe(`${BACKEND_URL}/api/v2/agents/a1/ssh-keys/k1`);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('/api/v2/agents остаётся локальным при наличии remote-подключения (не форвардится)', async () => {
    const fetchRouter = apiKeyFetchRouter(() => jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchRouter);

    const { dir, handle } = await makeHybridApp();
    const { app } = handle;
    try {
      const res = await app.request('/api/v2/agents', {
        headers: { Authorization: 'Bearer test-key' },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { agents: unknown[] };
      expect(Array.isArray(body.agents)).toBe(true);

      const forwarded = fetchRouter.mock.calls.filter(([u]) => {
        try {
          return new URL(String(u)).pathname.startsWith('/api/v2/agents');
        } catch {
          return false;
        }
      });
      expect(forwarded).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('без подключения → nested ssh-keys обслуживается локально (прокси не перехватывает)', async () => {
    const fetchRouter = apiKeyFetchRouter(() => jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchRouter);

    const dir = await mkdtemp(join(tmpdir(), 'synth-app-proxy-local-nested-'));
    try {
      const { app } = await createStandaloneApp({ port: 0, dataDir: dir, apiKey: 'test-key' });

      const res = await app.request('/api/v2/agents/a1/ssh-keys', {
        headers: { Authorization: 'Bearer test-key' },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([]);
      expect(fetchRouter).not.toHaveBeenCalled();
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
});
