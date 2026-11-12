// commandAudit: домен API v2 — журнал исполнений команд shell (PROP-136a).
//
// Записи — факт исполнения `execute_shell`/`sandbox_exec`: обезличенная команда,
// решение permission-слоя (`allow`/`deny`/`ask`), внешний чекер (провайдер),
// длительность и код возврата. Чтение — ADMIN/AUDITOR, retention-очистка
// (`DELETE`) — только ADMIN (guard сервера; UI лишь прячет недоступное).

import type { CommandAuditDecision, CommandAuditEntry } from '@itphx/synth-shared/types'
import { BASE_URL, fetchJSON } from './base'

export type { CommandAuditDecision, CommandAuditEntry }

/** Фильтры журнала (все опциональны; сервер сам отсекает лишние). */
export interface CommandAuditQuery {
  /** Точная id сессии. */
  sessionId?: string
  /** Точная id проекта. */
  projectId?: string
  /** Начало диапазона по времени (ISO-8601, включительно). */
  from?: string
  /** Конец диапазона по времени (ISO-8601, включительно). */
  to?: string
  /** Решение permission-слоя: `allow`/`deny`/`ask`. */
  decision?: CommandAuditDecision
  /** Сколько записей вернуть (сервер обрезает до 1000). */
  limit?: number
}

/** Ответ `GET /audit/commands` — записи (свежие первыми) и их число. */
export interface CommandAuditListResponse {
  entries: CommandAuditEntry[]
  count: number
}

/** Ответ `DELETE /audit/commands` — число удалённых записей. */
export interface CommandAuditPruneResponse {
  removed: number
}

function buildQuery(params: Array<[string, string | number | undefined]>): string {
  const q = new URLSearchParams()
  for (const [key, value] of params) {
    if (value === undefined || value === '') continue
    q.set(key, String(value))
  }
  const qs = q.toString()
  return qs ? `?${qs}` : ''
}

export const commandAuditApi = {
  /**
   * GET /audit/commands — журнал исполнений (свежие первыми).
   * Фильтры: `session_id`/`project_id`/`from`/`to`/`decision`/`limit`.
   */
  async getCommandAudit(query: CommandAuditQuery = {}): Promise<CommandAuditListResponse> {
    return fetchJSON<CommandAuditListResponse>(
      `${BASE_URL}/audit/commands${buildQuery([
        ['session_id', query.sessionId],
        ['project_id', query.projectId],
        ['from', query.from],
        ['to', query.to],
        ['decision', query.decision],
        ['limit', query.limit],
      ])}`,
    )
  },

  /** DELETE /audit/commands?older_than_days=N — retention-очистка (только ADMIN). */
  async pruneCommandAudit(olderThanDays: number): Promise<CommandAuditPruneResponse> {
    return fetchJSON<CommandAuditPruneResponse>(
      `${BASE_URL}/audit/commands${buildQuery([['older_than_days', olderThanDays]])}`,
      { method: 'DELETE' },
    )
  },
}
