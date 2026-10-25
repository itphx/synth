// session-memory: домен API v2 (ADR-095) — память в контексте сессии.
//
// ADR-107 / PROP-047: срез памяти, относящийся к конкретной сессии: что
// провайдер памяти отдал в контекст последнего хода (факты и recall), каков
// скоуп (проект/инстанс) и сколько индексов/fактов доступно.
//
// Отличие от `lib/api/memory.ts` (портал памяти для админ-раздела «Память»):
// здесь read-only срез по сессии, права — чтение сессии.
//
// Типы объявлены локально (как в соседних доменах): тянуть core в браузерный
// бандл нельзя (см. `packages/ui/AGENTS.md`).

import { BASE_URL, fetchJSON } from './base'

/** Статус блока памяти в контексте хода. */
export type SessionMemoryBlockStatus = 'loaded' | 'truncated' | 'empty' | 'blocked' | 'suppressed'

/** Готовность памяти для сессии. */
export type SessionMemoryReadiness = 'ready' | 'degraded' | 'unavailable'

/** Блок памяти, попавший в контекст хода (факты или recall). */
export interface SessionMemoryBlock {
  /** Размер блока в символах. */
  chars: number
  /** Оценка размера блока в токенах. */
  estTokens: number
  /** Что произошло с блоком. */
  status: SessionMemoryBlockStatus
}

/** Блоки памяти из последнего хода сессии. */
export interface SessionMemoryLastContext {
  /** Блок фактов памяти. */
  facts?: SessionMemoryBlock
  /** Блок recall (поиск по индексу) — есть, если у хода был вопрос. */
  recall?: SessionMemoryBlock
}

/** Счётчики индексов памяти в скоупе сессии. */
export interface SessionMemoryIndexes {
  /** Всего индексов. */
  total: number
  /** Индексы проекта. */
  project: number
  /** Индексы инстанса (общие). */
  instance: number
  /** Готовые индексы. */
  ready: number
  /** Индексы в работе. */
  building: number
  /** Индексы с ошибкой. */
  failed: number
}

/** Ответ `GET /sessions/:id/memory`. */
export interface SessionMemoryResponse {
  /** Провайдер памяти (активен ли плагин). */
  provider: { active: boolean }
  /** Скоуп памяти сессии (проект, если сессия в проекте). */
  scope: { projectId?: string }
  /** Блоки памяти из последнего хода (`null` — ходов ещё не было). */
  lastContext: SessionMemoryLastContext | null
  /** Активные факты памяти. */
  facts: { active: number }
  /** Счётчики индексов. */
  indexes: SessionMemoryIndexes
  /** Готовность памяти. */
  readiness: SessionMemoryReadiness
}

export const sessionMemoryApi = {
  /**
   * GET /sessions/:id/memory — память в контексте сессии (ADR-107).
   *
   * Права — чтение сессии. Ошибки сервера: 404 (сессия не найдена),
   * 409 `MEMORY_PROVIDER_UNAVAILABLE` (плагин памяти не активен),
   * 503 `MEMORY_UNAVAILABLE` (порты памяти не подключены).
   */
  async getSessionMemory(sessionId: string): Promise<SessionMemoryResponse> {
    return fetchJSON<SessionMemoryResponse>(
      `${BASE_URL}/sessions/${encodeURIComponent(sessionId)}/memory`,
    )
  },
}
