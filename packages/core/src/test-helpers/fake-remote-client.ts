/**
 * Фейковый `RemoteBackendClient` для тестов гибридного форварда
 * (ADR-042/ADR-130): план/журнал/инварианты удалённого проекта и ToDo
 * удалённой сессии уходят на backend, а не в локальное хранилище.
 *
 * Клиент отдаёт **сырой** `Response` — как при `raw: true` в реальном
 * `RemoteBackendClient.request` (форвард читает статус и тело ответа).
 */
import type { RemoteBackendClient, RequestOptions } from '../remote/client.js';

/** Зафиксированный вызов удалённого backend. */
export interface FakeRemoteCall {
  method: string;
  path: string;
  body: unknown;
  opts: RequestOptions | undefined;
}

/** Обработчик вызова: ответ удалённой стороны. */
export type FakeRemoteHandler = (call: FakeRemoteCall) => Response | Promise<Response>;

/** Фейковый клиент + журнал вызовов. */
export interface FakeRemoteClient {
  client: RemoteBackendClient;
  calls: FakeRemoteCall[];
}

/**
 * Создать фейкового клиента удалённого backend.
 *
 * `handler` получает параметры вызова и возвращает `Response` — так же,
 * как отвечает реальный backend.
 */
export function createFakeRemoteClient(handler: FakeRemoteHandler): FakeRemoteClient {
  const calls: FakeRemoteCall[] = [];
  const client = {
    request: async (method: string, path: string, body?: unknown, opts?: RequestOptions) => {
      const call: FakeRemoteCall = { method, path, body, opts };
      calls.push(call);
      return handler(call);
    },
  } as unknown as RemoteBackendClient;
  return { client, calls };
}

/** JSON-ответ удалённой стороны. */
export function remoteJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Пустой ответ `204` (удаление записи/пункта). */
export function remoteNoContent(): Response {
  return new Response(null, { status: 204 });
}
