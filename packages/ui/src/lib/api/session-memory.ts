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

/** Состояние индекса памяти в срезе сессии. */
export type SessionMemoryIndexState = 'building' | 'ready' | 'stale' | 'failed'

/** Область видимости индекса: проектный или общий для инстанса. */
export type SessionMemoryIndexScope = 'project' | 'instance'

/** Индекс памяти в скоупе сессии (без корпуса — только метаданные). */
export interface SessionMemoryIndexItem {
  /** Идентификатор индекса. */
  id: string
  /** Имя индекса. */
  name: string
  /** Область видимости. */
  scope: SessionMemoryIndexScope
  /** Состояние сборки. */
  state: SessionMemoryIndexState
  /** Участвует ли индекс в recall (у общих всегда `true`). */
  enabled: boolean
  /** Проект-владелец (у общих — источник корпуса, может отсутствовать). */
  projectId?: string
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
  /** Индексы в скоупе (для списка в правой панели). */
  items: SessionMemoryIndexItem[]
}

/** Настройки памяти проекта (эффективное значение). */
export interface SessionProjectMemory {
  /** Включена ли память проекта. */
  enabled: boolean
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
  /** Память проекта (`null` — сессия без проекта). */
  projectMemory?: SessionProjectMemory | null
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
