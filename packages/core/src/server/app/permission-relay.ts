// Пересылка ответа на подтверждение прав в удалённый backend (гибрид).
//
// Ожидающий `ask` живёт в процессе, который исполняет ход: у сессии `remote:<id>`
// это удалённый backend. Локальный core/WS/HTTP получает ответ пользователя и
// обязан переслать его туда — иначе грант не выдаётся и `session.updated` не
// возвращается в UI (ответ «залипает» в локальном мире).
import type { RemoteBackendClient } from '../../remote/client.js';
import { RemoteError } from '../../remote/types.js';

/** Тело `POST /api/v2/sessions/:id/permissions/:approvalId`. */
export interface RemotePermissionReplyBody {
  action: 'allow' | 'deny' | 'hold';
  once?: boolean;
  turn_id?: string;
  digest?: string;
}

/** Исход пересылки: успех (тело удалённой стороны) либо ошибка с кодом. */
export type RemotePermissionRelayResult =
  | { ok: true; status: number; body: unknown }
  | { ok: false; status?: number; error: string; code?: string };

/**
 * Нормализовать WS-кадр `permission_reply`: новый формат `action`, старый —
 * `approved`. Аддитивные `once`/`turn_id`/`digest` пробрасываются только при
 * валидном значении.
 */
export function buildRemotePermissionReplyBody(msg: {
  action?: unknown;
  approved?: unknown;
  once?: unknown;
  turn_id?: unknown;
  digest?: unknown;
}): RemotePermissionReplyBody {
  const action: 'allow' | 'deny' = msg.action === 'allow' || msg.action === 'deny'
    ? msg.action
    : (msg.approved === true ? 'allow' : 'deny');
  return {
    action,
    ...(typeof msg.once === 'boolean' ? { once: msg.once } : {}),
    ...(typeof msg.turn_id === 'string' && msg.turn_id.trim() !== ''
      ? { turn_id: msg.turn_id }
      : {}),
    ...(typeof msg.digest === 'string' ? { digest: msg.digest } : {}),
  };
}

/** Достать `error.message`/`error.code` из тела ответа удалённой стороны. */
function extractRemoteError(body: unknown): { message: string; code?: string } {
  const error = body && typeof body === 'object'
    ? (body as { error?: unknown }).error
    : undefined;
  if (error && typeof error === 'object') {
    const e = error as { message?: unknown; code?: unknown };
    return {
      message: typeof e.message === 'string' ? e.message : 'Ошибка удалённого сервера',
      ...(typeof e.code === 'string' ? { code: e.code } : {}),
    };
  }
  return { message: 'Ошибка удалённого сервера' };
}

/**
 * Переслать ответ и привести исход к `RemotePermissionRelayResult`.
 *
 * Сетевые ошибки `RemoteBackendClient` (OFFLINE/UNAUTHORIZED/…) не бросаются
 * наружу — WS-путь отвечает клиенту кадром `error`, HTTP-путь пробрасывает
 * `RemoteError` дальше через `remoteErrorToHttp` (там вызывается именно
 * `client.permissionReply`, а не этот хелпер).
 */
export async function relayRemotePermissionReply(
  client: RemoteBackendClient,
  sessionId: string,
  approvalId: string,
  body: RemotePermissionReplyBody,
): Promise<RemotePermissionRelayResult> {
  try {
    const res = await client.permissionReply(sessionId, approvalId, body);
    if (res.status >= 400) {
      const error = extractRemoteError(res.body);
      return {
        ok: false,
        status: res.status,
        error: error.message,
        ...(error.code ? { code: error.code } : {}),
      };
    }
    return { ok: true, status: res.status, body: res.body };
  } catch (err) {
    if (err instanceof RemoteError) {
      return { ok: false, error: err.message, code: err.code };
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
