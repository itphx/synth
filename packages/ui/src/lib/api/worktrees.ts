// worktrees: домен API v2 (ADR-114) — инвентарь git-worktree'ов проекта.
//
// Серверный контракт (core, `server/routes/projects.ts` + `server/routes/sessions.ts`):
//   GET    /api/v2/projects/:id/worktrees               → { worktrees: WorktreeSummary[] }
//   POST   /api/v2/projects/:id/worktrees               → 201 { worktree, setup? }
//   DELETE /api/v2/projects/:id/worktrees/:wid?force=true → 204
//   POST   /api/v2/projects/:id/worktrees/prune         → { recordsRemoved, gitPruned }
//   PATCH  /api/v2/sessions/:id { worktreeId: string|null } → 200 (сессия)
//
// Ошибка удаления грязного worktree — `409` с `error.code = 'WORKTREE_DIRTY'` и
// `error.forceRequired = true`: домен не глотает её, а пробрасывает разобранную
// ошибку (`status`/`code`/`forceRequired` — из `fetchJSON`), чтобы UI показал
// второй шаг подтверждения и повторил запрос с `force`.
//
// Типы — type-only из `@itphx/synth-shared/types` (модуль стирается
// компилятором, core в браузерный бандл не попадает).

import type {
  WorktreeRecord,
  WorktreeStrategy,
  WorktreeSummary,
  WorktreeUpdateAction,
} from '@itphx/synth-shared/types'
import { BASE_URL, fetchJSON } from './base'
import type { SessionData } from './sessions'

export type { WorktreeRecord, WorktreeStrategy, WorktreeSummary, WorktreeUpdateAction }

/** Тело создания worktree (`POST /projects/:id/worktrees`). */
export interface WorktreeCreateInput {
  /** Ветка worktree (пусто — сервис подставит свою от базовой ветки). */
  branch?: string
  /** Имя каталога worktree (slug). */
  name?: string
  /** Репозиторий относительно `project.workspace` (пусто — корень workspace). */
  repoPath?: string
  /** База ветки при создании (`main`/`master`/SHA). */
  from?: string
}

/** Итог startup-скрипта проекта для созданного worktree. */
export interface WorktreeSetupResult {
  /** Выполнился ли скрипт без ошибки. */
  ok: boolean
  /** Код выхода скрипта. */
  exitCode?: number
  /** Текст ошибки скрипта. */
  error?: string
}

/** Ответ создания worktree. */
export interface WorktreeCreateResult {
  /** Созданная запись. */
  worktree: WorktreeSummary
  /** Итог startup-скрипта (если скрипт у проекта задан). */
  setup?: WorktreeSetupResult
}

/** Ответ prune — что и сколько вычищено. */
export interface WorktreePruneResult {
  /** Сколько записей удалено (записи без каталога). */
  recordsRemoved: number
  /** Выполнен ли `git worktree prune` в репозитории. */
  gitPruned: boolean
}

/** Ответ списка worktree'ов проекта. */
export interface WorktreeListResponse {
  worktrees: WorktreeSummary[]
}

export const worktreesApi = {
  /** GET /projects/:id/worktrees — инвентарь worktree'ов проекта. */
  async listWorktrees(projectId: string): Promise<WorktreeSummary[]> {
    const response = await fetchJSON<WorktreeListResponse>(
      `${BASE_URL}/projects/${encodeURIComponent(projectId)}/worktrees`,
    )
    return response.worktrees ?? []
  },

  /** POST /projects/:id/worktrees — создать worktree (ветка/имя — необязательные). */
  async createWorktree(
    projectId: string,
    input: WorktreeCreateInput = {},
  ): Promise<WorktreeCreateResult> {
    return fetchJSON<WorktreeCreateResult>(
      `${BASE_URL}/projects/${encodeURIComponent(projectId)}/worktrees`,
      { method: 'POST', body: JSON.stringify(input) },
    )
  },

  /**
   * DELETE /projects/:id/worktrees/:wid — удалить worktree.
   *
   * `force: true` снимает worktree вместе с незакоммиченными изменениями.
   * Без `force` грязный worktree даёт `409 WORKTREE_DIRTY` + `forceRequired`.
   */
  async removeWorktree(
    projectId: string,
    id: string,
    opts: { force?: boolean } = {},
  ): Promise<void> {
    const query = opts.force ? '?force=true' : ''
    await fetchJSON<void>(
      `${BASE_URL}/projects/${encodeURIComponent(projectId)}/worktrees/${encodeURIComponent(id)}${query}`,
      { method: 'DELETE' },
    )
  },

  /** POST /projects/:id/worktrees/prune — вычистить записи без каталога. */
  async pruneWorktrees(projectId: string): Promise<WorktreePruneResult> {
    return fetchJSON<WorktreePruneResult>(
      `${BASE_URL}/projects/${encodeURIComponent(projectId)}/worktrees/prune`,
      { method: 'POST' },
    )
  },

  /**
   * PATCH /sessions/:id { worktreeId } — привязать сессию к worktree
   * (`worktreeId: null` — снять привязку). Возвращает обновлённую сессию
   * (поле `worktree` — snake_case-снимок привязки либо `null`).
   */
  async bindWorktree(sessionId: string, worktreeId: string | null): Promise<SessionData> {
    return fetchJSON<SessionData>(
      `${BASE_URL}/sessions/${encodeURIComponent(sessionId)}`,
      { method: 'PATCH', body: JSON.stringify({ worktreeId }) },
    )
  },
}
