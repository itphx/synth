// snippets: домен API v2 (ADR-095) — объект `snippetsApi` и его DTO.
// ADR-141 §4: сниппеты `#name` — именованные текстовые фрагменты, которые
// раскрываются в сообщении до отправки (не команда, не промпт, не скилл).

import { BASE_URL, fetchJSON } from './base'

/** Уровень сниппета (ADR-141 §4: instance/project/user). */
export type SnippetScope = 'instance' | 'project' | 'user'

/**
 * Сниппет одного уровня (ответ `GET /api/v2/snippets`).
 *
 * `trusted: false` — сниппет виден в списке, но не раскрывается (недоверенный
 * проектный каталог; ADR-046 §4.4 / ADR-141 §4 «Безопасность»).
 */
export interface Snippet {
  /** Каноническое имя (`[a-z][a-z0-9_-]{0,79}`). */
  name: string
  /** Описание из frontmatter (необязательное). */
  description?: string
  /** Алиасы из frontmatter (не перекрывают каноническое имя). */
  aliases: string[]
  /** Тело сниппета (markdown без frontmatter). */
  body: string
  /** Уровень (instance/project/user). */
  scope: SnippetScope
  /** Файл-источник (absolute path). */
  file: string
  /** Доверен ли источник: `false` — сниппет не раскрывается. */
  trusted: boolean
}

/** Диагностика реестра сниппетов (коллизии, недоверие, ошибки чтения). */
export interface SnippetDiagnostic {
  level: 'error' | 'warning' | 'info'
  code: 'shadowed' | 'untrusted' | 'read-error' | 'invalid-frontmatter' | 'limit-exceeded'
  message: string
  /** Имя сниппета (если известно). */
  snippet?: string
  /** Путь к файлу (если применимо). */
  path?: string
}

/** Ответ `GET /api/v2/snippets`. */
export interface SnippetsListResponse {
  snippets: Snippet[]
  diagnostics?: SnippetDiagnostic[]
}

/** Ответ `POST /api/v2/snippets/expand` (предпросмотр раскрытия). */
export interface SnippetExpandResponse {
  /** Текст после раскрытия `#`-токенов. */
  text: string
  /** Имена раскрытых сниппетов (по порядку подстановки). */
  applied: string[]
  diagnostics?: SnippetDiagnostic[]
}

/** Параметры списка сниппетов. */
export interface SnippetListParams {
  /** Проект: подтягивает project-сниппеты его рабочего каталога. */
  projectId?: string
  /** Фильтр по уровню. */
  scope?: SnippetScope
}

export const snippetsApi = {
  /**
   * GET /snippets — список сниппетов (instance + свой user-уровень; project —
   * при `projectId` и праве чтения проекта).
   */
  async listSnippets(params?: SnippetListParams): Promise<SnippetsListResponse> {
    const q = new URLSearchParams()
    if (params?.projectId) q.set('projectId', params.projectId)
    if (params?.scope) q.set('scope', params.scope)
    const qs = q.toString()
    return fetchJSON<SnippetsListResponse>(`${BASE_URL}/snippets${qs ? `?${qs}` : ''}`)
  },

  /**
   * POST /snippets — создание сниппета (`instance` / `project` / `user`).
   *
   * Права записи проверяет сервер: instance — администратор, user — только
   * сам пользователь, project — право изменения содержимого проекта.
   */
  async createSnippet(input: {
    name: string
    body: string
    description?: string
    aliases?: string[]
    scope: SnippetScope
    projectId?: string
  }): Promise<Snippet> {
    return fetchJSON<Snippet>(`${BASE_URL}/snippets`, {
      method: 'POST',
      body: JSON.stringify(input),
    })
  },

  /** PATCH /snippets/:name — правка / переименование / перенос уровня. */
  async updateSnippet(
    name: string,
    patch: {
      name?: string
      body?: string
      /** `null` — сброс описания. */
      description?: string | null
      /** `[]` — сброс алиасов. */
      aliases?: string[]
      scope?: SnippetScope
      projectId?: string
    },
  ): Promise<Snippet> {
    return fetchJSON<Snippet>(`${BASE_URL}/snippets/${encodeURIComponent(name)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    })
  },

  /** DELETE /snippets/:name — удаление сниппета. */
  async deleteSnippet(name: string, opts?: { projectId?: string }): Promise<void> {
    const q = opts?.projectId ? `?projectId=${encodeURIComponent(opts.projectId)}` : ''
    await fetchJSON<{ status: string }>(`${BASE_URL}/snippets/${encodeURIComponent(name)}${q}`, {
      method: 'DELETE',
    })
  },

  /** POST /snippets/expand — предпросмотр раскрытия `#`-токенов (без записи). */
  async expandSnippets(text: string, projectId?: string): Promise<SnippetExpandResponse> {
    return fetchJSON<SnippetExpandResponse>(`${BASE_URL}/snippets/expand`, {
      method: 'POST',
      body: JSON.stringify(projectId ? { text, projectId } : { text }),
    })
  },
}
