// Проксирование серверных/админ-эндпоинтов на удалённый backend (гибрид, Batch 2, T5).
// Гибрид подключается в рантайме (RemoteConnection), поэтому middleware получает
// ГЕТТЕР клиента: если подключения нет — getClient() возвращает null, middleware
// делает next() и запрос обрабатывают локальные роуты (404 либо обычная логика).
// Когда клиент есть, пути из REMOTE_PROXY_PREFIXES (простые префиксы) и
// REMOTE_PROXY_PATTERNS (точечные regex, напр. вложенный
// /api/v2/agents/:agentId/ssh-keys) форвардятся на {backendUrl}/api/v2/... с
// Bearer-токеном: сохраняются method/query/тело (JSON) и статус/заголовки/тело
// ответа (включая SSE). Остальные пути /api/v2/agents/* остаются локальными
// (агенты — per-instance).

import type { Context, MiddlewareHandler } from 'hono';
import type { RemoteBackendClient } from '../remote/client.js';
// ADR-099: форвард на удалённый backend — через единый egress-транспорт
// (доверие TLS/CA + HTTP-прокси), а не «сырой» глобальный fetch.
import { egressFetch } from '../security/tls.js';

/**
 * Префиксы, источник истины которых — удалённый backend (в гибриде LLM
 * централизован, управление провайдерами/моделями/пользователями/аудитом —
 * только на сервере).
 */
export const REMOTE_PROXY_PREFIXES = [
  '/api/v2/audit',
  '/api/v2/users',
  '/api/v2/admin',
  '/api/v2/logs',
  '/api/v2/gateway',
  '/api/v2/context',
  '/api/v2/llm',
  '/api/v2/providers',
  '/api/v2/models',
  '/api/v2/git',
  '/api/v2/ssh-keys',
] as const;

/**
 * Точечные паттерны для путей, которые нельзя покрыть простым префиксом:
 * вложенные SSH-ключи агента (`/api/v2/agents/:agentId/ssh-keys[/:keyId]`).
 * Важно: `/api/v2/agents` и его прочие подпути (`/all`, `/:id/enabled`)
 * остаются локальными — агенты per-instance.
 */
export const REMOTE_PROXY_PATTERNS: readonly RegExp[] = [
  /^\/api\/v2\/agents\/[^/]+\/ssh-keys(?:\/|$)/,
];

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export function matchesProxyPrefix(path: string): boolean {
  if (REMOTE_PROXY_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`))) return true;
  return REMOTE_PROXY_PATTERNS.some((re) => re.test(path));
}

/**
 * Прямой форвард запроса на удалённый backend: сохраняет method/query/тело
 * (JSON) и проксирует Response как есть (статус, заголовки, тело — включая
 * SSE). Сетевая ошибка → 502 OFFLINE в формате {error:{code,message}}.
 */
async function forwardToRemote(
  c: Context,
  remoteClient: RemoteBackendClient,
  getToken: () => Promise<string | null>,
): Promise<Response> {
  const urlObj = new URL(c.req.url);
  const url = new URL(`${urlObj.pathname}${urlObj.search}`, remoteClient.backendUrl).toString();

  const headers: Record<string, string> = {};
  const token = await getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const init: RequestInit = { method: c.req.method, headers };
  const noBody = ['GET', 'HEAD'].includes(c.req.method);
  if (!noBody) {
    const body = await c.req.arrayBuffer();
    if (body.byteLength > 0) {
      init.body = body;
      const contentType = c.req.header('content-type') || 'application/json';
      headers['Content-Type'] = contentType;
    }
  }

  let res: Response;
  try {
    res = await egressFetch(url, init);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({
      error: { code: 'OFFLINE', message: `Сервер недоступен: ${reason}` },
    }), { status: 502, headers: { 'Content-Type': 'application/json' } });
  }

  const outHeaders = new Headers();
  res.headers.forEach((value, key) => {
    const k = key.toLowerCase();
    // content-length не копируем: Node пересчитает при записи в сокет.
    if (!HOP_BY_HOP_HEADERS.has(k) && k !== 'content-length') {
      outHeaders.set(key, value);
    }
  });
  return new Response(res.body, { status: res.status, headers: outHeaders });
}

/**
 * Hono-middleware: если путь из списка — форвард на backend, иначе next().
 * getClient() читает ТЕКУЩИЙ клиент (null → не проксируем, next()).
 */
export function createRemoteProxyMiddleware(
  getClient: () => RemoteBackendClient | null,
  getToken: () => Promise<string | null>,
): MiddlewareHandler {
  return async (c, next) => {
    if (!matchesProxyPrefix(c.req.path)) return next();
    const remoteClient = getClient();
    if (!remoteClient) return next();
    return forwardToRemote(c, remoteClient, getToken);
  };
}
