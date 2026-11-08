import { create } from 'zustand'
import type { ProjectData, GitRepoConfigData, EntityOrigin, PublishProjectResult } from '@/lib/api/synthApi'
import { synthApi } from '@/lib/api/synthApi'
import { useSessionsStore } from './sessionsStore'
import { useHybridStore } from './hybridStore'
import { i18nText } from '@/lib/i18n/text'
import { confirm } from '@/lib/confirm'

interface ProjectsStore {
  projects: ProjectData[]
  loading: boolean
  error: string | null
  /**
   * Всего проектов (из `total` страницы) — больше, чем в загруженной странице.
   */
  total: number
  /**
   * Курсор следующей страницы списка (`offset`); `null` — страница последняя.
   *
   * Список проектов **всегда пагинирован** (`GET /projects` → страница), в дереве
   * показывается первая страница и кнопка «Показать ещё».
   */
  nextOffset: number | null
  /** Идёт ли догрузка следующей страницы (`loadMoreProjects`). */
  loadingMore: boolean
  /**
   * Список показан по данным до потери связи (offline-деградация гибрида):
   * сервер ответил локальным миром (`remote_offline`), ранее загруженные
   * удалённые проекты сохранены.
   */
  stale: boolean

  loadProjects: () => Promise<void>
  /** Догрузить следующую страницу списка проектов (кнопка «Показать ещё»). */
  loadMoreProjects: () => Promise<void>
  getProject: (id: string) => Promise<ProjectData | null>
  createProject: (data: {
    name: string
    description?: string
    icon?: string | null
    color?: string | null
    workspace?: string | null
    repos?: GitRepoConfigData[]
    origin?: EntityOrigin
    /** ADR-075: согласие на workspace вне `workspacesRoot` (повтор после 409). */
    confirmOutsideRoot?: boolean
  }) => Promise<ProjectData>
  updateProject: (id: string, data: {
    name?: string
    description?: string
    icon?: string | null
    color?: string | null
    workspace?: string | null
    repos?: GitRepoConfigData[]
  }) => Promise<ProjectData | null>
  deleteProject: (id: string) => Promise<boolean>
  /** Заменяет проект в списке сохранённым объектом (после PATCH /projects/:id). */
  updateProjectInList: (project: ProjectData) => void
  // Перенос проектов между мирами (гибрид, UI publish/fork). Бросают ошибку при
  // неудаче — вызывающий код решает, что показать (паттерн setSessionMode).
  publishProject: (id: string, opts?: { remote_project_id?: string }) => Promise<PublishProjectResult>
  forkRemoteProject: (id: string, opts?: { local_name?: string }) => Promise<ProjectData>
}

/**
 * Размер страницы списка проектов.
 *
 * Совпадает с серверным дефолтом (`DEFAULT_PROJECTS_LIMIT` в core), но задаётся
 * явно: клиент не должен зависеть от серверного дефолта при смене версии.
 */
export const PROJECTS_PAGE_LIMIT = 100

/**
 * Слияние сводки списка с уже загруженной записью (PROP-054).
 *
 * Список проектов — **сводки** (ADR-118 §4): тяжёлых полей `plan` в них нет
 * (журнал `log` вынесен из детали совсем). Если запись уже есть в сторе с
 * загруженным планом, сводка его не затирает — иначе `loadProjects()` стирал
 * бы план открытого проекта (панель «Проект» показывала бы пустой план).
 *
 * Если сводка пришла **с** планом (деталь) — она авторитетна.
 */
function mergeProjectSummary(existing: ProjectData | undefined, incoming: ProjectData): ProjectData {
  if (!existing) return incoming
  if (incoming.plan !== undefined && incoming.plan !== null) return incoming
  return { ...existing, ...incoming, plan: existing.plan ?? null }
}

export const useProjectsStore = create<ProjectsStore>((set, get) => ({
  projects: [],
  loading: false,
  error: null,
  total: 0,
  nextOffset: null,
  loadingMore: false,
  stale: false,

  loadProjects: async () => {
    set({ loading: true, error: null })
    try {
      // Список проектов пагинирован: грузим **первую** страницу.
      const page = await synthApi.getProjectsPage({ limit: PROJECTS_PAGE_LIMIT })
      const remoteOffline = page.remote_offline === true
      useHybridStore.getState().markRemoteDegraded(remoteOffline)
      const incoming = page.projects ?? []
      set((s) => {
        if (!remoteOffline) {
          return {
            // Сводка не затирает уже загруженную деталь (план) — см. `mergeProjectSummary`.
            projects: incoming.map((item) => {
              const existing = s.projects.find((p) => p.id === item.id)
              return mergeProjectSummary(existing, item)
            }),
            total: typeof page.total === 'number' ? page.total : incoming.length,
            nextOffset: typeof page.next_offset === 'number' ? page.next_offset : null,
            loading: false,
            stale: false,
          }
        }
        // Offline-деградация: сервер отдал только локальный мир. Ранее
        // загруженные удалённые проекты не затираем.
        const hadRemote = s.projects.some((p) => p.origin === 'remote')
        const hasRemote = incoming.some((p) => p.origin === 'remote')
        if (hadRemote && !hasRemote) {
          return { loading: false, stale: true }
        }
        return {
          projects: incoming.map((item) => {
            const existing = s.projects.find((p) => p.id === item.id)
            return mergeProjectSummary(existing, item)
          }),
          total: typeof page.total === 'number' ? page.total : incoming.length,
          nextOffset: typeof page.next_offset === 'number' ? page.next_offset : null,
          loading: false,
          stale: true,
        }
      })
    } catch (e) {
      set({ error: (e as Error).message, loading: false })
    }
  },

  /**
   * Догрузка следующей страницы списка проектов (кнопка «Показать ещё»).
   *
   * Страница **дописывается** к уже загруженной: раскрытые проекты и выбранная
   * сессия не сбрасываются (список в сторе — единственный источник для дерева).
   */
  loadMoreProjects: async () => {
    const { nextOffset, loadingMore } = get()
    if (loadingMore || nextOffset === null) return
    set({ loadingMore: true })
    try {
      const page = await synthApi.getProjectsPage({
        limit: PROJECTS_PAGE_LIMIT,
        offset: nextOffset,
      })
      set((s) => {
        const seen = new Set(s.projects.map((p) => p.id))
        const incoming = (page.projects ?? []).filter((p) => !seen.has(p.id))
        return {
          projects: [...s.projects, ...incoming],
          total: typeof page.total === 'number' ? page.total : s.total,
          nextOffset: typeof page.next_offset === 'number' ? page.next_offset : null,
        }
      })
    } catch (e) {
      set({ error: (e as Error).message })
    } finally {
      set({ loadingMore: false })
    }
  },

  // Загружает проект по id и кладёт его в стор (upsert). Возвращает null при ошибке.
  getProject: async (id) => {
    try {
      const project = await synthApi.getProject(id)
      set((s) => {
        const exists = s.projects.some((p) => p.id === project.id)
        if (exists) {
          return { projects: s.projects.map((p) => (p.id === project.id ? project : p)) }
        }
        return { projects: [project, ...s.projects] }
      })
      return project
    } catch (e) {
      set({ error: (e as Error).message })
      return null
    }
  },

  // ADR-075: ошибки пробрасываются (как в publishProject/forkRemoteProject) —
  // вызывающий различает 409 `WORKSPACE_OUTSIDE_ROOT_CONFIRM_REQUIRED` и повторяет
  // запрос с `confirmOutsideRoot: true`.
  createProject: async (data) => {
    try {
      const project = await synthApi.createProject(data)
      set((s) => ({
        projects: [project, ...s.projects],
        // Курсор страниц считается по позициям на сервере: новый проект сдвигает
        // их на единицу, поэтому курсор уменьшается (иначе один проект выпадет
        // из выборки при догрузке).
        nextOffset: s.nextOffset === null ? null : Math.max(0, s.nextOffset - 1),
      }))
      return project
    } catch (e) {
      set({ error: (e as Error).message })
      throw e
    }
  },

  updateProject: async (id, data) => {
    try {
      const updated = await synthApi.updateProject(id, data)
      set((s) => ({
        projects: s.projects.map((p) => (p.id === id ? updated : p)),
      }))
      return updated
    } catch (e) {
      set({ error: (e as Error).message })
      return null
    }
  },

  deleteProject: async (id) => {
    // Гибрид: удаление удалённого проекта выполняется на сервере — подтверждение.
    const project = get().projects.find((p) => p.id === id)
    if (project?.origin === 'remote') {
      const ok = await confirm({ title: i18nText('hybrid.confirmDeleteRemoteProject'), variant: 'danger' })
      if (!ok) return false
    }
    try {
      await synthApi.deleteProject(id)
      set((s) => ({
        projects: s.projects.filter((p) => p.id !== id),
        // Список на сервере тоже сократился — курсор страниц сдвигается на
        // единицу (см. `createProject`).
        nextOffset: s.nextOffset === null ? null : Math.max(0, s.nextOffset - 1),
      }))
      return true
    } catch (e) {
      set({ error: (e as Error).message })
      return false
    }
  },

  updateProjectInList: (project) => {
    set((s) => ({ projects: s.projects.map((p) => (p.id === project.id ? project : p)) }))
  },

  // Гибрид: локальный проект → сервер (проект + сессии + файлы). После успеха
  // перечитываем списки — удалённая копия появляется в дереве проектов.
  publishProject: async (id, opts) => {
    try {
      const result = await synthApi.publishProject(id, opts)
      await get().loadProjects()
      await useSessionsStore.getState().loadSessions()
      return result
    } catch (e) {
      set({ error: (e as Error).message })
      throw e
    }
  },

  // Гибрид: удалённый проект → локальная копия (проект + сессии + файлы).
  forkRemoteProject: async (id, opts) => {
    try {
      const project = await synthApi.forkRemoteProject(id, opts)
      await get().loadProjects()
      await useSessionsStore.getState().loadSessions()
      return project
    } catch (e) {
      set({ error: (e as Error).message })
      throw e
    }
  },
}))
