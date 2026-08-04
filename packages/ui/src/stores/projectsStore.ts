import { create } from 'zustand'
import type { ProjectData, GitRepoConfigData } from '@/lib/api/synthApi'
import { synthApi } from '@/lib/api/synthApi'

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
}

export const useProjectsStore = create<ProjectsStore>((set) => ({
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
    try {
      await synthApi.deleteProject(id)
      set((s) => ({ projects: s.projects.filter((p) => p.id !== id) }))
      return true
    } catch (e) {
      set({ error: (e as Error).message })
      return false
    }
  },
}))
