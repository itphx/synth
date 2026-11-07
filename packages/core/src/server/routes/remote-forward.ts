/**
 * Форвард HTTP-запроса на удалённый backend (ADR-042, ADR-130).
 *
 * Гибрид: локальный core обслуживает **оба** мира. Сущности удалённого мира
 * адресуются id с префиксом `remote:` (инвариант 7) — запрос к ним уходит на
 * удалённый backend, а не в локальное хранилище.
 *
 * Правила форварда:
 * - **права и валидация — на удалённой стороне** (ADR-130): форвард happens
 *   **до** локальной проверки доступа/валидации тела, иначе локальный скоуп
 *   правил разошёлся бы с правилами удалённого мира;
 * - **HTTP-ответ удалённой стороны возвращается как есть**: статус и тело
 *   (в т.ч. `409 PLAN_VERSION_CONFLICT` с актуальным планом в теле);
 * - ошибки **транспорта** (`RemoteError`) мапятся через `remoteErrorToHttp`:
 *   `OFFLINE` → `502`, `UNAUTHORIZED` → `401`;
 * - `204` — пустое тело (`c.body(null, 204)`).
 */
import type { Context } from 'hono';
import type { RemoteBackendClient } from '../../remote/client.js';
import { remoteErrorToHttp } from '../../remote/aggregate.js';

/** HTTP-методы форварда (совпадают с `RemoteBackendClient.request`). */
export type RemoteForwardMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

/**
 * Статусы, которые фабрика может вернуть: стандартный набор API v2.
 * `204` обрабатывается отдельно — без тела (`c.body(null, 204)`).
 */
type ForwardStatus =
  | 200 | 201 | 202 | 400 | 401 | 403 | 404 | 409 | 413 | 422 | 429 | 500 | 502 | 503;

/**
 * Форвард запроса на удалённый backend.
 *
 * `client` — `null` → `502 REMOTE_UNAVAILABLE` (гибрид не настроен).
 * Исключение пробрасывается только если это **не** `RemoteError`
 * (программная ошибка — её видно в логах, а не подменяем кодом).
 */
export async function forwardRemoteRequest(
  c: Context,
  client: RemoteBackendClient | null,
  method: RemoteForwardMethod,
  path: string,
  body?: unknown,
): Promise<Response> {
  if (!client) {
    return c.json(
      { error: { code: 'REMOTE_UNAVAILABLE', message: 'Гибридный режим не настроен' } },
      502,
    );
  }
  try {
    const res = await client.request<Response>(method, path, body, {
      // Сырой Response: статус и тело удалённой стороны нужны как есть
      // (409 с актуальным планом, 400 с кодом ошибки и т.п.).
      raw: true,
      // HTTP-ошибку не превращаем в исключение — статус пробрасываем клиенту.
      allowHttpError: true,
    });
    if (res.status === 204) return c.body(null, 204);
    const text = await res.text();
    let payload: unknown = {};
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        // Не-JSON тело ошибки — отдаём как есть с кодом по статусу.
        payload = { error: { code: `HTTP_${res.status}`, message: text } };
      }
    }
    return c.json(payload as never, res.status as ForwardStatus);
  } catch (err) {
    const http = remoteErrorToHttp(err);
    if (!http) throw err;
    return c.json(
      { error: { code: http.code, message: err instanceof Error ? err.message : String(err) } },
      http.status as ForwardStatus,
    );
  }
}
