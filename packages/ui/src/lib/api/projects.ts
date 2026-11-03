// projects: домен API v2 (ADR-095) — объект `projectsApi` и его DTO.

import type { ProjectMcpSettings, ProjectPlan } from '@itphx/synth-shared'
import type { EntityOrigin } from './common'
import type { GitRepoConfigData } from './git'
import { BASE_URL, fetchJSON } from './base'

/** ADR-075: тело создания проекта; `confirmOutsideRoot` — согласие на путь вне `workspacesRoot`. */
export interface CreateProjectBody {
  name: string
  description?: string
  icon?: string | null
  color?: string | null
  workspace?: string | null
  repos?: GitRepoConfigData[] | null
  origin?: EntityOrigin
  confirmOutsideRoot?: boolean
}

/** ADR-075: тело обновления проекта; `confirmOutsideRoot` — согласие на путь вне `workspacesRoot`. */
export interface UpdateProjectBody {
  name?: string
  description?: string
  current_task?: string
  invariants?: string
  icon?: string | null
  color?: string | null
  workspace?: string | null
  repos?: GitRepoConfigData[] | null
  confirmOutsideRoot?: boolean
  /** ADR-107: настройки памяти проекта (эффективное значение). */
  memory?: { enabled: boolean } | null
}

export interface ProjectData {
  id: string
  /** Происхождение сущности (гибридный режим): local — локальный мир, remote — удалённый backend. */
  origin?: EntityOrigin
  name: string
  owner_id: string
  members: Record<string, string>
  description: string
  current_task: string
  invariants: string
  icon: string | null
  color: string | null
  workspace: string | null
  repos: GitRepoConfigData[] | null
  status_messages: Array<{
    id: string
    text: string
    type: string
    timestamp: string
  }>
  log?: { id: string; text: string; created_at: string; session_id?: string | null; author?: string | null }[] | null
  /**
   * План проекта (ADR-039).
   *
   * В **сводке** списка (`GET /projects`) его нет — план тяжёлый, он в детали
   * `GET /projects/:id`. Поэтому поле опционально.
   */
  plan?: ProjectPlan | null
  /** ADR-071 §2.4: проектный скоуп MCP (owner/lead). */
  mcp?: ProjectMcpSettings | null
  created_at: string
  updated_at: string
}

/** Параметры страницы списка проектов (`GET /api/v2/projects`). */
export interface ProjectListParams {
  /** Размер страницы (сервер: по умолчанию 100, максимум 500). */
  limit?: number
  /** Смещение страницы (номер первого элемента). */
  offset?: number
}

/**
 * Страница списка проектов (`GET /api/v2/projects`).
 *
 * Элементы — **сводки** проекта: без тяжёлых полей `log`/`plan` (деталь —
 * `GET /api/v2/projects/:id`). `next_offset` — курсор следующей страницы,
 * `null` — страница последняя.
 */
export interface ProjectListPage {
  projects: ProjectData[]
  /** Всего проектов (больше, чем в загруженной странице). */
  total: number
  offset: number
  limit: number
  next_offset: number | null
}

/**
 * Максимальный размер страницы на сервере (`MAX_PROJECTS_LIMIT` в core).
 */
const PROJECTS_MAX_LIMIT = 500

/** Страховка обхода страниц в обёртке `getProjects` (защита от бесконечного цикла). */
const PROJECTS_MAX_PAGES = 50

export interface ProjectStats {
  total_sessions: number
  total_input_tokens: number
  total_output_tokens: number
  total_tokens: number
  /**
   * Счётчик сообщений проекта **удалён**: список сессий всегда лёгкий
   * (без истории), а история списком не отдаётся — считать сообщения было бы
   * нечем (ложный 0). Число сообщений одной сессии — в её статистике
   * (`GET /sessions/:id/stats`).
   */
  total_cache_read_tokens: number
  total_cache_write_tokens: number
  total_reasoning_tokens: number
}

/** Ответ POST /projects/:id/publish — перенос локального проекта на сервер. */
export interface PublishProjectResult {
  ok: boolean
  /** id удалённого проекта в remote-форме ('remote:<uuid>'). */
  project_id: string
  created: boolean
  sessions_imported: number
  files_uploaded: number
}

/** ADR-071 §2.4: ответ GET/PUT /projects/:id/mcp — проектный MCP-скоуп. */
export interface ProjectMcpResponse {
  enabled: string[]
  defaultOn: string[]
  knownServers: string[]
}

/**
 * Одна страница списка проектов (`GET /api/v2/projects`).
 *
 * Ответ — объект-страница `{projects, total, offset, limit, next_offset}`;
 * элементы — сводки (без `log`/`plan`).
 */
async function fetchProjectsPage(params?: ProjectListParams): Promise<ProjectListPage> {
  const query = new URLSearchParams()
  if (params?.limit !== undefined) query.set('limit', String(params.limit))
  if (params?.offset !== undefined) query.set('offset', String(params.offset))
  const qs = query.toString()
  return fetchJSON<ProjectListPage>(`${BASE_URL}/projects${qs ? `?${qs}` : ''}`)
}

export const projectsApi = {
  // Проекты
  /**
   * Страница списка проектов (`GET /api/v2/projects`).
   *
   * Список **всегда пагинирован**: первая страница + курсор `next_offset`.
   */
  async getProjectsPage(params?: ProjectListParams): Promise<ProjectListPage> {
    return fetchProjectsPage(params)
  },

  /**
   * Список проектов **целиком** — обёртка над страницей.
   *
   * Для потребителей, которым нужен массив, а не страница (админка, диалоги
   * выбора): страницы обходятся подряд, пока сервер не отдаст `next_offset:
   * null`. Списки, которые растут (дерево проектов), берут страницу через
   * {@link projectsApi.getProjectsPage} — с кнопкой «Показать ещё».
   */
  async getProjects(): Promise<ProjectData[]> {
    const projects: ProjectData[] = []
    let offset: number | undefined
    for (let page = 0; page < PROJECTS_MAX_PAGES; page++) {
      const result = await fetchProjectsPage({
        limit: PROJECTS_MAX_LIMIT,
        ...(offset !== undefined ? { offset } : {}),
      })
      projects.push(...(result.projects ?? []))
      const next = result.next_offset
      if (typeof next !== 'number') break
      offset = next
    }
    return projects
  },

  async getProject(id: string): Promise<ProjectData> {
    return fetchJSON<ProjectData>(`${BASE_URL}/projects/${encodeURIComponent(id)}`)
  },

  async createProject(data: CreateProjectBody): Promise<ProjectData> {
    return fetchJSON<ProjectData>(`${BASE_URL}/projects`, {
      method: 'POST',
      body: JSON.stringify(data),
    })
  },

  async updateProject(id: string, data: UpdateProjectBody): Promise<ProjectData> {
    return fetchJSON<ProjectData>(`${BASE_URL}/projects/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    })
  },

  async deleteProject(id: string): Promise<void> {
    return fetchJSON<void>(`${BASE_URL}/projects/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    })
  },

  /** ADR-071 §2.4: проектный MCP-скоуп (owner/lead/admin). */
  async getProjectMcp(projectId: string): Promise<ProjectMcpResponse> {
    return fetchJSON<ProjectMcpResponse>(`${BASE_URL}/projects/${encodeURIComponent(projectId)}/mcp`)
  },

  /** ADR-071 §2.4: задать проектный MCP-скоуп (owner/lead/admin). */
  async updateProjectMcp(
    projectId: string,
    body: { enabled?: string[]; defaultOn?: string[] },
  ): Promise<ProjectMcpResponse> {
    return fetchJSON<ProjectMcpResponse>(`${BASE_URL}/projects/${encodeURIComponent(projectId)}/mcp`, {
      method: 'PUT',
      body: JSON.stringify(body),
    })
  },

  // Перенос проектов между мирами (гибрид): publish — локальный проект на сервер,
  // fork-local — удалённый проект в локальный мир. Сессии и файлы переносятся всегда.
  async publishProject(id: string, opts?: { remote_project_id?: string }): Promise<PublishProjectResult> {
    return fetchJSON<PublishProjectResult>(`${BASE_URL}/projects/${encodeURIComponent(id)}/publish`, {
      method: 'POST',
      body: JSON.stringify(opts || {}),
    })
  },

  async forkRemoteProject(id: string, opts?: { local_name?: string }): Promise<ProjectData> {
    return fetchJSON<ProjectData>(`${BASE_URL}/projects/${encodeURIComponent(id)}/fork-local`, {
      method: 'POST',
      body: JSON.stringify(opts || {}),
    })
  },

  async getProjectStats(id: string): Promise<ProjectStats> {
    return fetchJSON<ProjectStats>(`${BASE_URL}/projects/${encodeURIComponent(id)}/stats`)
  },
}
