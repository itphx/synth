import { describe, it, expect, beforeEach, vi } from 'vitest'

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

import { openProcessLogTab, processLogTabTitle } from './processTabs'
import { useUIStore } from '@/stores/useUIStore'

beforeEach(() => {
  useUIStore.setState({ centerTabs: [], activeCenterTabId: null })
})

describe('processTabs — открытие вкладки «Вывод процесса»', () => {
  it('заголовок вкладки — команда, затем описание, затем id', () => {
    expect(processLogTabTitle({ id: 'bgr_1', command: 'npm test' })).toBe('npm test')
    expect(processLogTabTitle({ id: 'bgr_1', description: 'Рефакторинг' })).toBe('Рефакторинг')
    expect(processLogTabTitle({ id: 'bgr_1' })).toBe('bgr_1')
  })

  it('открывает вкладку типа process-log с id прогона в данных', () => {
    openProcessLogTab({
      id: 'bgr_1',
      command: 'npm test',
      sessionId: 's1',
      projectId: 'p1',
    })

    const tab = useUIStore.getState().centerTabs[0]
    expect(tab?.id).toBe('process-bgr_1')
    expect(tab?.type).toBe('process-log')
    expect(tab?.title).toBe('npm test')
    expect(tab?.data.processRunId).toBe('bgr_1')
    expect(tab?.data.sessionId).toBe('s1')
    expect(tab?.data.projectId).toBe('p1')
    expect(useUIStore.getState().activeCenterTabId).toBe('process-bgr_1')
  })

  it('повторное открытие переиспользует ту же вкладку', () => {
    openProcessLogTab({ id: 'bgr_1', command: 'npm test' })
    openProcessLogTab({ id: 'bgr_1', command: 'npm test' })

    expect(useUIStore.getState().centerTabs).toHaveLength(1)
  })

  it('пустые sessionId/projectId в данные вкладки не попадают', () => {
    openProcessLogTab({ id: 'bgr_1', command: 'npm test', sessionId: null, projectId: null })

    const tab = useUIStore.getState().centerTabs[0]
    expect(tab?.data.sessionId).toBeUndefined()
    expect(tab?.data.projectId).toBeUndefined()
  })
})
