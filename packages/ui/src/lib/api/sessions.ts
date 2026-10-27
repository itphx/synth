// sessions: домен API v2 (ADR-095) — объект `sessionsApi` и его DTO.

import type {
  PromptHistoryInfo,
  PromptManifest,
  PromptMeta,
  PromptState,
  PromptToolDetail,
  SessionStats,
  TodoItem,
} from '@itphx/synth-shared'
import type { SessionMode, SteerMode } from '@itphx/synth-shared/types'
import type { EntityOrigin } from './common'
import { BASE_URL, fetchJSON } from './base'

export interface SessionData {
  id: string
  /** Происхождение сущности (гибридный режим): local — локальный мир, remote — удалённый backend. */
  origin?: EntityOrigin
  name: string | null
  parent_id?: string | null
  branch_point?: string | null
  /** Флаг «план утверждён через plan_exit» (ADR-039), сериализуется как plan_approved. */
  plan_approved?: boolean | null
  /** Todo-список сессии (тул todo_write), сериализуется как todos. */
  todos?: TodoItem[] | null
  session_origin?: string | null
  /** Текущий runtime-режим сессии (ADR-025): 'plan' — только чтение, 'act' — полный доступ, 'yolo' — автоподтверждение. */
  mode?: SessionMode
  /** Применим ли переключатель режимов к агенту сессии (ADR-025). false для read-only агентов. undefined → считается true. */
  mode_applicable?: boolean
  user_id: string | null
  owner_id: string | null
  project_id: string | null
  /**
   * ADR-114: привязка к worktree (рабочий каталог сессии) — null/undefined,
   * если привязки нет.
   */
  worktree?: SessionWorktreeBinding | null
  /** Канонический ключ иконки сессии (PROJECT_ICON_KEYS) или null. */
  icon?: string | null
  /** Канонический ключ цвета сессии (PROJECT_COLOR_KEYS) или null. */
  color?: string | null
  messages: Array<{
    index: number
    id?: string
    seq?: number
    origin?: string
    source_msg_id?: string | null
    parts?: Array<{ id: string; type: string; data: unknown }> | null
    role: string
    content: string
    author: string | null
    disabled: boolean
    pinned: boolean
    usage: Record<string, number> | null
    timestamp: string
    tool_calls?: unknown
    tool_call_id?: string | null
    reasoning?: string | null
    reasoning_blocks?: unknown | null
    intermediate_text_blocks?: unknown | null
    source?: string | null
    agent_role?: string | null
    summary_of?: number[] | null
    debug_data?: Record<string, unknown> | null
    metadata?: Record<string, unknown> | null
  }>
  pending_messages: unknown[]
  status: {
    blocked: string | null
  }
  settings: Record<string, unknown>
  sticky_notes: StickyNoteData[]
  summarization_pending: boolean
  can_summarize: boolean
  input_tokens: number
  output_tokens: number
  total_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  reasoning_tokens: number
  cache_hit_rate?: number
  processor_running: boolean | null
  created_at: string
  updated_at: string
}

/**
 * ADR-114: привязка сессии к git-worktree — **снимок** на момент привязки
 * (каталог/ветка копируются из записи, чтобы резолв рабочего каталога не
 * требовал чтения порта на каждом ходу). В ответах API — snake_case.
 */
export interface SessionWorktreeBinding {
  /** Идентификатор записи worktree. */
  worktree_id: string
  /** Проект-владелец worktree. */
  project_id: string
  /** Репозиторий относительно `project.workspace` (null — корень workspace). */
  repo_path: string | null
  /** Абсолютный путь каталога worktree. */
  directory: string
  /** Ветка на момент привязки. */
  branch: string
}

export interface StickyNoteData {
  id: string
  content: string
  created_at: string
  updated_at: string
  disabled: boolean
}

/** Вид блокирующего прогона, который можно перевести в фон (ADR-111 §detach). */
export type BackgroundDetachKind = 'subagent' | 'process'

/** Переведённый в фон прогон в ответе `POST /sessions/:id/background`. */
export interface BackgroundDetachItem {
  /** id прогона (для `subagent` — id дочерней сессии). */
  id: string
  kind: BackgroundDetachKind
  /** Человеческое имя прогона (команда шелла / описание саб-агента), если известно. */
  title?: string
}

/** Прогон, который перевести не удалось (ответ `POST /sessions/:id/background`). */
export interface BackgroundDetachFailure {
  id: string
  kind: BackgroundDetachKind
  /** Код отказа (`DETACH_UNSUPPORTED`, ...). */
  code: string
  message?: string
}

/**
 * Ответ `POST /sessions/:id/background` (ADR-111 §detach): пустой `detached` —
 * штатный исход «нечего переводить», а не ошибка.
 */
export interface BackgroundSessionResponse {
  sessionId: string
  detached: BackgroundDetachItem[]
  failed?: BackgroundDetachFailure[]
}

/** ADR-070 §2.5: ответ GET /sessions/:id/prompt — состав системного промпта. */
export interface PromptInfoResponse {
  manifest: PromptManifest
  history: PromptHistoryInfo
  promptState: PromptState | null
  lastPromptMeta: PromptMeta | null
  /** ADR-071 §2.6: per-tool данные встроенных инструментов (аддитивно). */
  toolsDetail?: PromptToolDetail[]
}

export const sessionsApi = {
  // Сессии
  async getSessions(projectId?: string | null): Promise<SessionData[]> {
    const params = new URLSearchParams()
    if (projectId !== undefined && projectId !== null) {
      params.set('project_id', projectId)
    }
    const qs = params.toString()
    return fetchJSON<SessionData[]>(`${BASE_URL}/sessions${qs ? `?${qs}` : ''}`)
  },

  async getSession(sessionId: string): Promise<SessionData> {
    return fetchJSON<SessionData>(`${BASE_URL}/sessions/${encodeURIComponent(sessionId)}`)
  },

  /** ADR-070 §2.5: манифест промпта + состояние активного агента + последний promptMeta. */
  async getSessionPrompt(sessionId: string): Promise<PromptInfoResponse> {
    return fetchJSON<PromptInfoResponse>(`${BASE_URL}/sessions/${encodeURIComponent(sessionId)}/prompt`)
  },

  /** ADR-070 §2.6: статистика сессии по агентам и авторам сообщений. */
  async getSessionStats(sessionId: string): Promise<SessionStats> {
    return fetchJSON<SessionStats>(`${BASE_URL}/sessions/${encodeURIComponent(sessionId)}/stats`)
  },

  async createSession(data: {
    name?: string
    icon?: string | null
    color?: string | null
    project_id?: string | null
    settings?: Record<string, unknown>
    origin?: EntityOrigin
  }): Promise<SessionData> {
    return fetchJSON<SessionData>(`${BASE_URL}/sessions`, {
      method: 'POST',
      body: JSON.stringify(data),
    })
  },

  // move/rename объединены в PATCH (API v2)
  async updateSession(sessionId: string, data: {
    name?: string
    icon?: string | null
    color?: string | null
    project_id?: string | null
    settings?: Record<string, unknown>
  }): Promise<SessionData> {
    return fetchJSON<SessionData>(`${BASE_URL}/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    })
  },

  // Plan/Act режим сессии (ADR-025)
  async patchSessionMode(sessionId: string, mode: SessionMode): Promise<SessionData> {
    return fetchJSON<SessionData>(`${BASE_URL}/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ mode }),
    })
  },

  async deleteSession(sessionId: string): Promise<void> {
    return fetchJSON<void>(`${BASE_URL}/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
    })
  },

  async forkSession(sessionId: string, options?: { message_id?: string; message_index?: number; title?: string }): Promise<SessionData> {
    return fetchJSON<SessionData>(`${BASE_URL}/sessions/${encodeURIComponent(sessionId)}/fork`, {
      method: 'POST',
      body: JSON.stringify(options || {}),
    })
  },

  async getSessionReferences(sessionId: string): Promise<{ references: Array<{ sessionId: string; label: string; messageRange: [number, number]; autoSummary?: string; createdAt: string }> }> {
    return fetchJSON(`${BASE_URL}/sessions/${encodeURIComponent(sessionId)}/references`)
  },

  async addSessionReference(sessionId: string, sourceSessionId: string, options?: { 
    label?: string; 
    messageRange?: [number, number]; 
    autoSummarize?: boolean;
    position?: 'after' | 'before';
  }): Promise<{ reference: Record<string, unknown> }> {
    return fetchJSON(`${BASE_URL}/sessions/${encodeURIComponent(sessionId)}/references`, {
      method: 'POST',
      body: JSON.stringify({ source_session_id: sourceSessionId, ...options }),
    })
  },

  async removeSessionReference(sessionId: string, refSessionId: string): Promise<void> {
    return fetchJSON<void>(`${BASE_URL}/sessions/${encodeURIComponent(sessionId)}/references/${encodeURIComponent(refSessionId)}`, {
      method: 'DELETE',
    })
  },

  async mergeMessages(sessionId: string, sourceSessionId: string, options: { sourceRange: [number, number]; position?: 'after' | 'before'; anchorMessageId?: string; summarize?: boolean }): Promise<{ messages: unknown[] }> {
    return fetchJSON(`${BASE_URL}/sessions/${encodeURIComponent(sessionId)}/messages/merge`, {
      method: 'POST',
      body: JSON.stringify({ source_session_id: sourceSessionId, source_range: options.sourceRange, ...options }),
    })
  },

  async clearSession(sessionId: string): Promise<SessionData> {
    return fetchJSON(`${BASE_URL}/sessions/${encodeURIComponent(sessionId)}/clear`, {
      method: 'POST',
    })
  },

  // API v2: отправить сообщение без чтения SSE-стрима (для SSE-режима)
  async enqueueMessage(sessionId: string, message: string, options?: {
    agentRole?: string
    streamId?: string
    provider?: string
    model?: string
    /**
     * ADR-104: режим отправки (`queue` по умолчанию, `steer` — вмешательство
     * в активный ход, `interrupt` — прерывание текущей генерации с
     * продолжением хода). `queue`/не задано — поле не уходит (обратная
     * совместимость).
     */
    mode?: SteerMode
    /**
     * ADR-115: id загруженных вложений (`partId`). Непустой список уходит в
     * тело как `attachments`; пустой — поле не появляется.
     */
    attachments?: string[]
  }): Promise<void> {
    const body: Record<string, unknown> = {
      content: message,
      stream: true,
      agent: options?.agentRole,
      provider: options?.provider,
      model: options?.model,
      messageId: options?.streamId || `stream-${Date.now()}`,
      ...(options?.mode && options.mode !== 'queue' ? { mode: options.mode } : {}),
      ...(options?.attachments && options.attachments.length > 0
        ? { attachments: options.attachments }
        : {}),
    }

    const response = await fetch(`${BASE_URL}/sessions/${encodeURIComponent(sessionId)}/prompt`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const error = await response.json().catch(() => ({ detail: 'Enqueue failed' }))
      throw new Error(error.detail || `HTTP ${response.status}`)
    }
  },

  // API v2: abort
  async stopGeneration(sessionId: string): Promise<void> {
    return fetchJSON(`${BASE_URL}/sessions/${encodeURIComponent(sessionId)}/abort`, {
      method: 'POST',
    })
  },

  /**
   * ADR-111 §detach: перевести идущие блокирующие прогоны сессии в фон.
   * Тело необязательно — без `type` переводятся все (саб-агенты и шелл);
   * пустой `detached` в ответе — «нечего переводить» (не ошибка).
   */
  async backgroundSession(
    sessionId: string,
    opts?: { type?: BackgroundDetachKind },
  ): Promise<BackgroundSessionResponse> {
    return fetchJSON<BackgroundSessionResponse>(
      `${BASE_URL}/sessions/${encodeURIComponent(sessionId)}/background`,
      {
        method: 'POST',
        ...(opts?.type ? { body: JSON.stringify({ type: opts.type }) } : {}),
      },
    )
  },

  // API v2: возобновить прерванную/ошибочную дочернюю сессию саб-агента (202, выполнение фоновое)
  async resumeSubagent(childSessionId: string): Promise<{
    status: string
    child_session_id: string
    parent_session_id: string
    stream_id: string
  }> {
    return fetchJSON(`${BASE_URL}/sessions/${encodeURIComponent(childSessionId)}/resume-subagent`, {
      method: 'POST',
    })
  },

  // Оптимизация контекста
  async getOptimization(sessionId: string): Promise<{
    context_optimization: string
    sliding_window_mode: string
    sliding_window_message_limit: number
    sliding_window_token_threshold: number
    summarization_enabled: boolean
    summarization_trigger_mode: string
    summarize_after_n: number
    summarize_token_threshold: number
    summarization_head_messages: number
    summarization_tail_messages: number
  }> {
    return fetchJSON(`${BASE_URL}/sessions/${encodeURIComponent(sessionId)}/optimization`)
  },

  async updateOptimization(
    sessionId: string,
    data: {
      context_optimization?: string
      sliding_window_mode?: string
      sliding_window_message_limit?: number
      sliding_window_token_threshold?: number
      summarization_enabled?: boolean
      summarization_trigger_mode?: string
      summarize_after_n?: number
      summarize_token_threshold?: number
      summarization_head_messages?: number
      summarization_tail_messages?: number
    },
  ): Promise<SessionData> {
    return fetchJSON(`${BASE_URL}/sessions/${encodeURIComponent(sessionId)}/optimization`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    })
  },

  async summarizeSession(sessionId: string): Promise<{
    status: string
    stream_id: string
  }> {
    return fetchJSON(`${BASE_URL}/sessions/${encodeURIComponent(sessionId)}/summarize`, {
      method: 'POST',
    })
  },

  async cancelSummarization(sessionId: string): Promise<{ success: boolean }> {
    return fetchJSON(`${BASE_URL}/sessions/${encodeURIComponent(sessionId)}/optimization/cancel-summarization`, {
      method: 'POST',
    })
  },

  // Sticky notes
  async addStickyNote(sessionId: string, content: string): Promise<{
    note: StickyNoteData
    notes: StickyNoteData[]
  }> {
    return fetchJSON(`${BASE_URL}/sessions/${encodeURIComponent(sessionId)}/notes`, {
      method: 'POST',
      body: JSON.stringify({ content }),
    })
  },

  async getStickyNotes(sessionId: string): Promise<{ notes: StickyNoteData[] }> {
    return fetchJSON(`${BASE_URL}/sessions/${encodeURIComponent(sessionId)}/notes`)
  },

  async updateStickyNote(sessionId: string, noteId: string, data: {
    content?: string
    disabled?: boolean
  }): Promise<{ notes: StickyNoteData[] }> {
    return fetchJSON(`${BASE_URL}/sessions/${encodeURIComponent(sessionId)}/notes/${encodeURIComponent(noteId)}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    })
  },

  async deleteStickyNote(sessionId: string, noteId: string): Promise<{ notes: StickyNoteData[] }> {
    return fetchJSON(`${BASE_URL}/sessions/${encodeURIComponent(sessionId)}/notes/${encodeURIComponent(noteId)}`, {
      method: 'DELETE',
    })
  },
}
