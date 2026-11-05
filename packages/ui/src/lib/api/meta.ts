// meta: домен API v2 — возможности инстанса (ADR-118 §8).
//
// `GET /api/v2/meta` — публичная информация о протоколе инстанса:
// версия модели сообщений (`messageModel`), поддержка нумерации событий
// (`eventSeq`), догон по журналу (`replay`) и версия инстанса.
//
// Сверка **fail-closed**: клиент, чья `messageModel` не совпадает с
// серверной, не подключается к потоку событий (тихая деградация запрещена —
// расхождение порядка и догона даёт испорченную ленту).

import type { InstanceCapabilities } from '@itphx/synth-shared/types'
import { BASE_URL, fetchJSON } from './base'

/** Мета недоступна → всё равно подключаемся (fail-open на клиенте), но по таймауту. */
const META_TIMEOUT_MS = 5_000

export const metaApi = {
  /** Возможности инстанса (`GET /api/v2/meta`). */
  async getInstanceCapabilities(): Promise<InstanceCapabilities> {
    return fetchJSON<InstanceCapabilities>(`${BASE_URL}/meta`, { timeoutMs: META_TIMEOUT_MS })
  },
}
