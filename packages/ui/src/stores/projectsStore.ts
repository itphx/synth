import { create } from 'zustand'
import type { ProjectData, GitRepoConfigData, EntityOrigin, PublishProjectResult } from '@/lib/api/synthApi'
import { synthApi } from '@/lib/api/synthApi'
import { useSessionsStore } from './sessionsStore'
import { i18nText } from '@/lib/i18n/text'
import { confirm } from '@/lib/confirm'

interface ProjectsStore {
  projects: ProjectData[]
  loading: boolean
  error: string | null

  loadProjects: () => Promise<void>
  getProject: (id: string) => Promise<ProjectData | null>
  createProject: (data: {
    name: string
    description?: string
    icon?: string | null
    color?: string | null
    workspace?: string | null
    repos?: GitRepoConfigData[]
    origin?: EntityOrigin
  }) => Promise<ProjectData | null>
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

export const useProjectsStore = create<ProjectsStore>((set, get) => ({
  projects: [],
  loading: false,
  error: null,

  loadProjects: async () => {
    set({ loading: true, error: null })
    try {
      const projects = await synthApi.getProjects()
      set({ projects, loading: false })
    } catch (e) {
      set({ error: (e as Error).message, loading: false })
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

  createProject: async (data) => {
    try {
      const project = await synthApi.createProject(data)
      set((s) => ({ projects: [project, ...s.projects] }))
      return project
    } catch (e) {
      set({ error: (e as Error).message })
      return null
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
      set((s) => ({ projects: s.projects.filter((p) => p.id !== id) }))
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
