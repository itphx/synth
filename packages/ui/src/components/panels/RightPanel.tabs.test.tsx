import { describe, it, expect, vi } from 'vitest'

// persist (zustand) в useUIStore пишет в localStorage — в Node/vitest его нет.
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

import { RIGHT_TABS } from './RightPanel'
import { useUIStore } from '@/stores/useUIStore'

describe('RightPanel — порядок вкладок (ADR-071)', () => {
  it('первый ряд — «Сессия», «Проект», «Контекст», «Статистика»', () => {
    const ids = RIGHT_TABS.map((tab) => tab.id)
    expect(ids).toEqual(['params', 'project', 'context', 'stats', 'references', 'scheduler'])
    expect(ids.indexOf('params')).toBe(0)
    expect(ids.indexOf('project')).toBe(1)
    expect(ids.indexOf('context')).toBe(2)
    expect(ids.indexOf('stats')).toBe(3)
  })

  it('дефолтная вкладка правой панели — «Контекст»', () => {
    expect(useUIStore.getState().rightPanelTab).toBe('context')
  })
})
