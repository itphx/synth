import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { SessionData } from '@/lib/api/synthApi'

// persist (zustand) захватывает localStorage при импорте useUIStore, а Node/vitest
// без --localstorage-file его не даёт — ставим заглушку до импорта стора.
vi.hoisted(() => {
  const data = new Map<string, string>()
  const ls = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      data.set(k, v)
    },
    removeItem: (k: string) => {
      data.delete(k)
    },
    clear: () => {
      data.clear()
    },
  }
  Object.defineProperty(globalThis, 'localStorage', { value: ls, configurable: true })
  if (typeof window !== 'undefined') {
    Object.defineProperty(window, 'localStorage', { value: ls, configurable: true })
  }
})

const mocks = vi.hoisted(() => ({
  updateSession: vi.fn(),
  getSessions: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({ synthApi: mocks }))
// Транспорт в тестах не подключён — локальное применение ответа (как при офлайне).
vi.mock('./transportStore', () => ({ isTransportConnected: () => false }))

import { useSessionsStore } from './sessionsStore'
import { useUIStore, type CenterTab } from './useUIStore'

function session(id: string, name: string | null): SessionData {
  return {
    id,
    name,
    user_id: 'u1',
    owner_id: 'u1',
    project_id: null,
    messages: [],
    pending_messages: [],
    status: { blocked: null },
    settings: {},
    sticky_notes: [],
    summarization_pending: false,
    can_summarize: false,
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    processor_running: false,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  }
}

function chatTab(sessionId: string, title: string): CenterTab {
  return { id: `chat-${sessionId}`, type: 'chat', title, data: { sessionId } }
}

describe('sessionsStore.regenerateSessionTitle', () => {
  beforeEach(() => {
    mocks.updateSession.mockReset()
    useSessionsStore.setState({ sessions: [session('s1', 'Старое название')], error: null })
    useUIStore.setState({ centerTabs: [chatTab('s1', 'Старое название')], activeCenterTabId: 'chat-s1' })
  })

  it('запрашивает перегенерацию (PATCH { title: "" }) и обновляет сессию в сторе', async () => {
    mocks.updateSession.mockResolvedValue(session('s1', 'Новое название'))

    const result = await useSessionsStore.getState().regenerateSessionTitle('s1')

    expect(mocks.updateSession).toHaveBeenCalledWith('s1', { title: '' })
    expect(result?.name).toBe('Новое название')
    expect(useSessionsStore.getState().sessions[0]!.name).toBe('Новое название')
  })

  it('обновляет заголовок открытого таба', async () => {
    mocks.updateSession.mockResolvedValue(session('s1', 'Новое название'))

    await useSessionsStore.getState().regenerateSessionTitle('s1')

    const tab = useUIStore.getState().centerTabs.find((t) => t.id === 'chat-s1')
    expect(tab?.title).toBe('Новое название')
  })

  it('ошибка: error в сторе, null на выходе, таб не трогаем', async () => {
    mocks.updateSession.mockRejectedValue(new Error('генерация не удалась'))

    const result = await useSessionsStore.getState().regenerateSessionTitle('s1')

    expect(result).toBeNull()
    expect(useSessionsStore.getState().error).toBe('генерация не удалась')
    expect(useSessionsStore.getState().sessions[0]!.name).toBe('Старое название')
    const tab = useUIStore.getState().centerTabs.find((t) => t.id === 'chat-s1')
    expect(tab?.title).toBe('Старое название')
  })
})

describe('sessionsStore.renameSession', () => {
  beforeEach(() => {
    mocks.updateSession.mockReset()
    useSessionsStore.setState({ sessions: [session('s1', 'Старое название')], error: null })
  })

  it('переименование не сломано: PATCH { name }, обновление сессии', async () => {
    mocks.updateSession.mockResolvedValue(session('s1', 'Своё имя'))

    const result = await useSessionsStore.getState().renameSession('s1', 'Своё имя')

    expect(mocks.updateSession).toHaveBeenCalledWith('s1', { name: 'Своё имя' })
    expect(result?.name).toBe('Своё имя')
    expect(useSessionsStore.getState().sessions[0]!.name).toBe('Своё имя')
  })

  it('ошибка: error в сторе, null на выходе', async () => {
    mocks.updateSession.mockRejectedValue(new Error('отказ'))

    const result = await useSessionsStore.getState().renameSession('s1', 'Своё имя')

    expect(result).toBeNull()
    expect(useSessionsStore.getState().error).toBe('отказ')
  })
})
