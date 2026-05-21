import { create } from 'zustand'
import type { SessionData } from '@/lib/api/synthApi'
import { synthApi } from '@/lib/api/synthApi'

interface SessionsStore {
  sessions: SessionData[]
  loading: boolean
  error: string | null

  loadSessions: (projectId?: string | null) => Promise<void>
  createSession: (data: {
    name?: string
    project_id?: string | null
    engine?: string
  }) => Promise<SessionData | null>
  moveSession: (sessionId: string, projectId: string | null) => Promise<SessionData | null>
  renameSession: (sessionId: string, newName: string) => Promise<SessionData | null>
  deleteSession: (sessionId: string) => Promise<boolean>
  getSessionsByProject: (projectId: string | null) => SessionData[]
}

export const useSessionsStore = create<SessionsStore>((set, get) => ({
  sessions: [],
  loading: false,
  error: null,

  loadSessions: async (projectId?) => {
    set({ loading: true, error: null })
    try {
      const sessions = await synthApi.getSessions(projectId)
      set({ sessions, loading: false })
    } catch (e) {
      set({ error: (e as Error).message, loading: false })
    }
  },

  createSession: async (data) => {
    try {
      const session = await synthApi.createSession(data)
      set((s) => ({ sessions: [session, ...s.sessions] }))
      return session
    } catch (e) {
      set({ error: (e as Error).message })
      return null
    }
  },

  moveSession: async (sessionId, projectId) => {
    try {
      const updated = await synthApi.updateSession(sessionId, { project_id: projectId })
      set((s) => ({
        sessions: s.sessions.map((sess) => (sess.id === sessionId ? updated : sess)),
      }))
      return updated
    } catch (e) {
      set({ error: (e as Error).message })
      return null
    }
  },

  renameSession: async (sessionId, newName) => {
    try {
      const updated = await synthApi.updateSession(sessionId, { name: newName })
      set((s) => ({
        sessions: s.sessions.map((sess) => (sess.id === sessionId ? updated : sess)),
      }))
      return updated
    } catch (e) {
      set({ error: (e as Error).message })
      return null
    }
  },

  async deleteSession(sessionId: string) {
    try {
      await fetch(`/api/v2/sessions/${encodeURIComponent(sessionId)}`, {
        method: 'DELETE',
        credentials: 'include',
      })
      set((s) => ({ sessions: s.sessions.filter((sess) => sess.id !== sessionId) }))
      return true
    } catch (e) {
      set({ error: (e as Error).message })
      return false
    }
  },

  getSessionsByProject: (projectId) => {
    return get().sessions.filter((s) => s.project_id === projectId)
  },
}))
