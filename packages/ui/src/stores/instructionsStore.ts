import { create } from 'zustand'
import { synthApi, type InstructionsInfo } from '../lib/api/synthApi'

/**
 * ADR-069 §9.3: снимки проектных инструкций по сессиям для UI-индикатора.
 *
 * Загрузка — по запросу панели и по WS-событию `context.instructions_loaded`
 * (диспетчер `transportStore`), чтобы список файлов/статусов обновлялся реактивно.
 */
export interface InstructionsStore {
  infoBySession: Record<string, InstructionsInfo | null>
  loadingBySession: Record<string, boolean>
  errorBySession: Record<string, string | null>

  load: (sessionId: string) => Promise<void>
  clear: (sessionId: string) => void
}

export const useInstructionsStore = create<InstructionsStore>((set) => ({
  infoBySession: {},
  loadingBySession: {},
  errorBySession: {},

  load: async (sessionId) => {
    if (!sessionId) return
    set((s) => ({
      loadingBySession: { ...s.loadingBySession, [sessionId]: true },
      errorBySession: { ...s.errorBySession, [sessionId]: null },
    }))
    try {
      const info = await synthApi.getSessionInstructions(sessionId)
      set((s) => ({
        infoBySession: { ...s.infoBySession, [sessionId]: info },
        loadingBySession: { ...s.loadingBySession, [sessionId]: false },
      }))
    } catch (e) {
      set((s) => ({
        loadingBySession: { ...s.loadingBySession, [sessionId]: false },
        errorBySession: {
          ...s.errorBySession,
          [sessionId]: e instanceof Error ? e.message : String(e),
        },
      }))
    }
  },

  clear: (sessionId) =>
    set((s) => {
      const infoBySession = { ...s.infoBySession }
      const loadingBySession = { ...s.loadingBySession }
      const errorBySession = { ...s.errorBySession }
      delete infoBySession[sessionId]
      delete loadingBySession[sessionId]
      delete errorBySession[sessionId]
      return { infoBySession, loadingBySession, errorBySession }
    }),
}))
