// Черновики текста композера по сессиям (zustand + ручной персист, ADR-115).
//
// Стор — тонкая прослойка над `lib/composer-drafts`: React-состояние для
// мгновенного ввода, запись в localStorage с дебаунсом внутри библиотеки.
// `persist`-middleware намеренно не используется (двойное хранилище и
// сериализация на каждый `set`).

import { create } from 'zustand'
import {
  flushComposerDrafts,
  readComposerDrafts,
  writeComposerDraft,
} from '@/lib/composer-drafts'

interface ComposerDraftsState {
  /** Текст композера по id сессии; отсутствие ключа — пустой черновик. */
  textBySession: Record<string, string>
  setText: (sessionId: string, text: string) => void
  clearText: (sessionId: string) => void
  /** Записать накопленные черновики в localStorage немедленно. */
  flush: () => void
}

function initialTextBySession(): Record<string, string> {
  const stored = readComposerDrafts()
  const result: Record<string, string> = {}
  for (const [sessionId, entry] of Object.entries(stored)) {
    result[sessionId] = entry.text
  }
  return result
}

export const useComposerDraftsStore = create<ComposerDraftsState>()((set, get) => ({
  textBySession: initialTextBySession(),

  setText(sessionId, text) {
    if (!sessionId) return
    set((state) => {
      if (text === '') {
        if (!(sessionId in state.textBySession)) return state
        const next = { ...state.textBySession }
        delete next[sessionId]
        return { textBySession: next }
      }
      if (state.textBySession[sessionId] === text) return state
      return { textBySession: { ...state.textBySession, [sessionId]: text } }
    })
    writeComposerDraft(sessionId, text)
  },

  clearText(sessionId) {
    if (!sessionId) return
    get().setText(sessionId, '')
  },

  flush() {
    flushComposerDrafts()
  },
}))

/** Текст композера конкретной сессии (селектор-хук). */
export function useComposerDraftText(sessionId: string): string {
  return useComposerDraftsStore((state) => state.textBySession[sessionId] ?? '')
}
