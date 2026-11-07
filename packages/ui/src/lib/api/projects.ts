// projects: домен API v2 (ADR-095) — объект `projectsApi` и его DTO.

import type { ProjectMcpSettings } from '@itphx/synth-shared'
// Типы плана — из subpath `/types` (value-импорты из корня `@itphx/synth-shared`
// запрещены: корень тянет `node:fs` в бандл UI).
import type { PlanDependency, PlanItem, ProjectPlan } from '@itphx/synth-shared/types'
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
  /**
   * PROP-125: источник каждого известного сервера (`local`/`server`) — для
   * бейджа «серверный» в панели «Проект».
   *
   * Отсутствует — источник неизвестен (старый сервер) — бейдж не рисуется.
   */
  sources?: Record<string, 'local' | 'server'>
}

// --- План проекта (PROP-054, волна 1) ---
//
// Точечные endpoint'ы плана: UI не пишет план целиком через `PUT /projects/:id`
// (ADR-039 + «Дополнение 2026-11-07» к PROP-054). Мутации — по правам
// `canEditProjectContent`; версия плана работает как оптимистичная блокировка
// для `move`/`delete column`/`columns/order` (409 `PLAN_VERSION_CONFLICT`).

/** Ответ точечных операций с планом: актуальный план целиком. */
export interface ProjectPlanResponse {
  plan: ProjectPlan | null
}

/** Приоритет пункта плана (`high`/`medium`/`low`). */
export type PlanItemPriority = PlanItem['priority']

/** Тело создания пункта плана (`POST /projects/:id/plan/items`). */
export interface PlanItemCreateBody {
  title: string
  /** Описание — Markdown (лимит 16 КиБ, проверяет сервер). */
  description?: string
  /** Колонка (статус). Не задана — сервер кладёт в `backlog`/первую по `order`. */
  columnId?: string
  priority?: PlanItemPriority
  dependsOn?: PlanDependency[]
  tags?: string[]
}

/** Тело правки пункта плана (`PATCH /projects/:id/plan/items/:itemId`). */
export interface PlanItemPatchBody {
  title?: string
  description?: string
  priority?: PlanItemPriority
  tags?: string[]
  dependsOn?: PlanDependency[]
}

/** Тело перемещения пункта плана (`PATCH …/plan/items/:itemId/move`). */
export interface PlanItemMoveBody {
  /** Целевая колонка. */
  columnId: string
  /** Поставить перед этим пунктом (внутри целевой колонки). */
  beforeItemId?: string
  /** Поставить после этого пункта (внутри целевой колонки). */
  afterItemId?: string
  /** Версия плана — оптимистичная блокировка (409 при расхождении). */
  version?: number
}

/** Тело создания колонки плана (`POST /projects/:id/plan/columns`). */
export interface PlanColumnCreateBody {
  name: string
  /** Лимит WIP (индикатор; запрета перемещения нет — PROP-054). */
  wipLimit?: number | null
}

/** Тело правки колонки плана (`PATCH /projects/:id/plan/columns/:columnId`). */
export interface PlanColumnPatchBody {
  name?: string
  wipLimit?: number | null
}

/** Тело удаления колонки плана (`DELETE /projects/:id/plan/columns/:columnId`). */
export interface PlanColumnDeleteBody {
  /** Куда перенести пункты колонки (`null` — удалить вместе с ними). */
  moveItemsTo: string | null
  /** Версия плана — обязательна (оптимистичная блокировка). */
  version: number
}

/** Тело порядка колонок плана (`PUT /projects/:id/plan/columns/order`). */
export interface PlanColumnsOrderBody {
  /** id колонок в новом порядке. */
  order: string[]
  /** Версия плана — обязательна (оптимистичная блокировка). */
  version: number
}

// --- Журнал проекта (PROP-054, волна 1) ---
//
// `log` убран из `GET /projects/:id`: единственный источник — страница
// `GET /projects/:id/log` (событие `project.updated` с `kind:'log'`).

/**
 * Запись журнала проекта — **на проводе** (snake_case).
 *
 * Локальный DTO: shared-типа записи журнала на проводе пока нет (backend-сабагент
 * добавит `ProjectLogEntry` в shared вместе с `updated_at`/`updated_by`).
 * Поля `id`/`text` совпадают, даты и сессия приходят в snake_case.
 */
export interface ProjectLogEntryDto {
  id: string
  /** Текст записи — Markdown (лимит 16 КиБ). */
  text: string
  created_at: string
  session_id?: string | null
  /** Автор: `userId` пользователя или роль агента. */
  author?: string | null
  /** Кто и когда правил запись (аддитивные поля). */
  updated_at?: string | null
  updated_by?: string | null
}

/** Страница журнала проекта (`GET /projects/:id/log`). */
export interface ProjectLogPage {
  entries: ProjectLogEntryDto[]
  /** Всего записей (больше, чем в загруженной странице). */
  total: number
  offset: number
  limit: number
  /** Курсор следующей страницы; `null` — страница последняя. */
  next_offset: number | null
}

/** Параметры страницы журнала. */
export interface ProjectLogListParams {
  /** Размер страницы (сервер: по умолчанию 50, максимум 200). */
  limit?: number
  /** Смещение страницы (номер первого элемента). */
  offset?: number
}

/** Ответ `POST/PATCH /projects/:id/log` — созданная/изменённая запись. */
export interface ProjectLogEntryResponse {
  entry: ProjectLogEntryDto
}

// --- Инварианты проекта (PROP-054, волна 1) ---

/** Ответ `GET/PUT /projects/:id/invariants`. */
export interface ProjectInvariantsResponse {
  /** Текст инвариантов — Markdown (лимит 64 КиБ). */
  invariants: string
  /** Когда обновляли (для показа актуального времени). */
  updated_at: string
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

  // --- План проекта (PROP-054) ---

  /** GET /projects/:id/plan — план целиком (для модального окна-доски). */
  async getProjectPlan(projectId: string): Promise<ProjectPlanResponse> {
    return fetchJSON<ProjectPlanResponse>(
      `${BASE_URL}/projects/${encodeURIComponent(projectId)}/plan`,
    )
  },

  /** POST /projects/:id/plan/items — создать пункт плана. */
  async createProjectPlanItem(
    projectId: string,
    body: PlanItemCreateBody,
  ): Promise<ProjectPlanResponse> {
    return fetchJSON<ProjectPlanResponse>(
      `${BASE_URL}/projects/${encodeURIComponent(projectId)}/plan/items`,
      { method: 'POST', body: JSON.stringify(body) },
    )
  },

  /** PATCH /projects/:id/plan/items/:itemId — изменить поля пункта. */
  async updateProjectPlanItem(
    projectId: string,
    itemId: string,
    body: PlanItemPatchBody,
  ): Promise<ProjectPlanResponse> {
    return fetchJSON<ProjectPlanResponse>(
      `${BASE_URL}/projects/${encodeURIComponent(projectId)}/plan/items/${encodeURIComponent(itemId)}`,
      { method: 'PATCH', body: JSON.stringify(body) },
    )
  },

  /**
   * PATCH /projects/:id/plan/items/:itemId/move — переместить/переупорядочить.
   *
   * `version` — оптимистичная блокировка: при расхождении сервер отвечает
   * `409 PLAN_VERSION_CONFLICT` и кладёт актуальный план в тело.
   */
  async moveProjectPlanItem(
    projectId: string,
    itemId: string,
    body: PlanItemMoveBody,
  ): Promise<ProjectPlanResponse> {
    return fetchJSON<ProjectPlanResponse>(
      `${BASE_URL}/projects/${encodeURIComponent(projectId)}/plan/items/${encodeURIComponent(itemId)}/move`,
      { method: 'PATCH', body: JSON.stringify(body) },
    )
  },

  /** DELETE /projects/:id/plan/items/:itemId — удалить пункт. */
  async deleteProjectPlanItem(
    projectId: string,
    itemId: string,
  ): Promise<ProjectPlanResponse> {
    return fetchJSON<ProjectPlanResponse>(
      `${BASE_URL}/projects/${encodeURIComponent(projectId)}/plan/items/${encodeURIComponent(itemId)}`,
      { method: 'DELETE' },
    )
  },

  /** POST /projects/:id/plan/columns — создать колонку плана. */
  async createProjectPlanColumn(
    projectId: string,
    body: PlanColumnCreateBody,
  ): Promise<ProjectPlanResponse> {
    return fetchJSON<ProjectPlanResponse>(
      `${BASE_URL}/projects/${encodeURIComponent(projectId)}/plan/columns`,
      { method: 'POST', body: JSON.stringify(body) },
    )
  },

  /** PATCH /projects/:id/plan/columns/:columnId — переименовать колонку / задать WIP. */
  async updateProjectPlanColumn(
    projectId: string,
    columnId: string,
    body: PlanColumnPatchBody,
  ): Promise<ProjectPlanResponse> {
    return fetchJSON<ProjectPlanResponse>(
      `${BASE_URL}/projects/${encodeURIComponent(projectId)}/plan/columns/${encodeURIComponent(columnId)}`,
      { method: 'PATCH', body: JSON.stringify(body) },
    )
  },

  /**
   * DELETE /projects/:id/plan/columns/:columnId — удалить колонку.
   *
   * `moveItemsTo` — колонка, куда переносятся пункты (`null` — удалить их).
   * `version` обязателен: при расхождении — `409 PLAN_VERSION_CONFLICT`.
   */
  async deleteProjectPlanColumn(
    projectId: string,
    columnId: string,
    body: PlanColumnDeleteBody,
  ): Promise<ProjectPlanResponse> {
    return fetchJSON<ProjectPlanResponse>(
      `${BASE_URL}/projects/${encodeURIComponent(projectId)}/plan/columns/${encodeURIComponent(columnId)}`,
      { method: 'DELETE', body: JSON.stringify(body) },
    )
  },

  /** PUT /projects/:id/plan/columns/order — новый порядок колонок. */
  async reorderProjectPlanColumns(
    projectId: string,
    body: PlanColumnsOrderBody,
  ): Promise<ProjectPlanResponse> {
    return fetchJSON<ProjectPlanResponse>(
      `${BASE_URL}/projects/${encodeURIComponent(projectId)}/plan/columns/order`,
      { method: 'PUT', body: JSON.stringify(body) },
    )
  },

  // --- Журнал проекта (PROP-054) ---

  /** GET /projects/:id/log — страница журнала (новые сверху). */
  async getProjectLogPage(
    projectId: string,
    params?: ProjectLogListParams,
  ): Promise<ProjectLogPage> {
    const query = new URLSearchParams()
    if (params?.limit !== undefined) query.set('limit', String(params.limit))
    if (params?.offset !== undefined) query.set('offset', String(params.offset))
    const qs = query.toString()
    return fetchJSON<ProjectLogPage>(
      `${BASE_URL}/projects/${encodeURIComponent(projectId)}/log${qs ? `?${qs}` : ''}`,
    )
  },

  /** POST /projects/:id/log — добавить запись журнала. */
  async createProjectLogEntry(
    projectId: string,
    body: { text: string },
  ): Promise<ProjectLogEntryResponse> {
    return fetchJSON<ProjectLogEntryResponse>(
      `${BASE_URL}/projects/${encodeURIComponent(projectId)}/log`,
      { method: 'POST', body: JSON.stringify(body) },
    )
  },

  /** PATCH /projects/:id/log/:entryId — изменить текст записи. */
  async updateProjectLogEntry(
    projectId: string,
    entryId: string,
    body: { text: string },
  ): Promise<ProjectLogEntryResponse> {
    return fetchJSON<ProjectLogEntryResponse>(
      `${BASE_URL}/projects/${encodeURIComponent(projectId)}/log/${encodeURIComponent(entryId)}`,
      { method: 'PATCH', body: JSON.stringify(body) },
    )
  },

  /** DELETE /projects/:id/log/:entryId — удалить запись (204). */
  async deleteProjectLogEntry(projectId: string, entryId: string): Promise<void> {
    return fetchJSON<void>(
      `${BASE_URL}/projects/${encodeURIComponent(projectId)}/log/${encodeURIComponent(entryId)}`,
      { method: 'DELETE' },
    )
  },

  // --- Инварианты проекта (PROP-054) ---

  /** GET /projects/:id/invariants — текущий текст инвариантов. */
  async getProjectInvariants(projectId: string): Promise<ProjectInvariantsResponse> {
    return fetchJSON<ProjectInvariantsResponse>(
      `${BASE_URL}/projects/${encodeURIComponent(projectId)}/invariants`,
    )
  },

  /** PUT /projects/:id/invariants — заменить текст инвариантов (лимит 64 КиБ). */
  async putProjectInvariants(
    projectId: string,
    body: { invariants: string },
  ): Promise<ProjectInvariantsResponse> {
    return fetchJSON<ProjectInvariantsResponse>(
      `${BASE_URL}/projects/${encodeURIComponent(projectId)}/invariants`,
      { method: 'PUT', body: JSON.stringify(body) },
    )
  },
}
