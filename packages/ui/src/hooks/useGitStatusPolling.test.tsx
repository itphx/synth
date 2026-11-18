import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

const mocks = vi.hoisted(() => ({ loadStatus: vi.fn(async () => {}) }))

vi.mock('@/stores/gitStore', () => ({
  useGitStore: { getState: () => ({ loadStatus: mocks.loadStatus }) },
}))

import { useGitStatusPolling } from './useGitStatusPolling'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []
let visibility: DocumentVisibilityState = 'visible'

function Probe({ ids }: { ids: string[] }) {
  useGitStatusPolling(ids, { intervalMs: 5000 })
  return null
}

async function render(ids: string[]): Promise<void> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(<Probe ids={ids} />)
  })
}

function setVisibility(next: DocumentVisibilityState): void {
  visibility = next
  document.dispatchEvent(new Event('visibilitychange'))
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  visibility = 'visible'
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibility,
  })
})

afterEach(async () => {
  while (roots.length > 0) {
    const { root, container } = roots.pop()!
    await act(async () => { root.unmount() })
    container.remove()
  }
  vi.useRealTimers()
})

describe('useGitStatusPolling', () => {
  it('первый тик выполняется сразу для всех проектов', async () => {
    await render(['p1', 'p2'])
    expect(mocks.loadStatus).toHaveBeenCalledWith('p1')
    expect(mocks.loadStatus).toHaveBeenCalledWith('p2')
    expect(mocks.loadStatus).toHaveBeenCalledTimes(2)
  })

  it('далее тикает по интервалу', async () => {
    await render(['p1'])
    expect(mocks.loadStatus).toHaveBeenCalledTimes(1)

    await act(async () => { vi.advanceTimersByTime(5000) })
    expect(mocks.loadStatus).toHaveBeenCalledTimes(2)

    await act(async () => { vi.advanceTimersByTime(5000) })
    expect(mocks.loadStatus).toHaveBeenCalledTimes(3)
  })

  it('пока вкладка скрыта — тики пропускаются', async () => {
    await render(['p1'])
    expect(mocks.loadStatus).toHaveBeenCalledTimes(1)

    await act(async () => { setVisibility('hidden') })
    await act(async () => { vi.advanceTimersByTime(15000) })

    expect(mocks.loadStatus).toHaveBeenCalledTimes(1)
  })

  it('на возвращении видимости — немедленный тик', async () => {
    await render(['p1'])
    await act(async () => { setVisibility('hidden') })
    await act(async () => { vi.advanceTimersByTime(5000) })
    expect(mocks.loadStatus).toHaveBeenCalledTimes(1)

    await act(async () => { setVisibility('visible') })
    expect(mocks.loadStatus).toHaveBeenCalledTimes(2)
  })

  it('после размонтирования таймеров и слушателей не остаётся', async () => {
    await render(['p1'])
    const { root, container } = roots.pop()!
    await act(async () => { root.unmount() })
    container.remove()

    await act(async () => { vi.advanceTimersByTime(20000) })
    expect(mocks.loadStatus).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })
})
