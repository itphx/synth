import { describe, it, expect, beforeEach, vi } from 'vitest'

// persist (zustand) захватывает localStorage при импорте стора, а Node/vitest без
// --localstorage-file его не даёт — ставим заглушку до импорта useUIStore.
const storage = vi.hoisted(() => {
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
  return ls
})

import { useUIStore, type CenterTab } from './useUIStore'

const tab = (id: string, title = id): CenterTab => ({
  id,
  type: 'chat',
  title,
  data: { sessionId: id },
})

describe('useUIStore.openTab', () => {
  beforeEach(() => {
    storage.clear()
    useUIStore.setState({
      centerTabs: [],
      activeCenterTabId: null,
      mobileLeftOpen: true,
      mobileRightOpen: true,
    })
  })

  it('новая вкладка: активирует её и сворачивает мобильную левую панель', () => {
    useUIStore.getState().openTab(tab('chat-1'))

    const s = useUIStore.getState()
    expect(s.centerTabs.map((t) => t.id)).toEqual(['chat-1'])
    expect(s.activeCenterTabId).toBe('chat-1')
    expect(s.mobileLeftOpen).toBe(false)
    // правая панель не затрагивается
    expect(s.mobileRightOpen).toBe(true)
  })

  it('существующая вкладка: обновляет title, активирует и сворачивает левую панель', () => {
    useUIStore.setState({ centerTabs: [tab('chat-1', 'Старое')] })
    useUIStore.getState().openTab(tab('chat-1', 'Новое'))

    const s = useUIStore.getState()
    expect(s.centerTabs).toHaveLength(1)
    expect(s.centerTabs[0].title).toBe('Новое')
    expect(s.activeCenterTabId).toBe('chat-1')
    expect(s.mobileLeftOpen).toBe(false)
    expect(s.mobileRightOpen).toBe(true)
  })
})
