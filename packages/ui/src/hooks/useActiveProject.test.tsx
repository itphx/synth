import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

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

import { useActiveProject, type ActiveProjectInfo } from './useActiveProject'
import { useUIStore, type CenterTab } from '@/stores/useUIStore'
import { useSessionsStore } from '@/stores/sessionsStore'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []
let captured: ActiveProjectInfo | null = null

function Probe() {
  captured = useActiveProject()
  return null
}

async function renderProbe(): Promise<void> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(<Probe />)
  })
  await act(async () => {})
}

const setTabs = (tabs: CenterTab[], activeId: string | null) => {
  useUIStore.setState({ centerTabs: tabs, activeCenterTabId: activeId })
}

beforeEach(() => {
  captured = null
  useSessionsStore.setState({ sessions: [] })
  setTabs([], null)
})

afterEach(async () => {
  while (roots.length > 0) {
    const { root, container } = roots.pop()!
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
})

describe('useActiveProject', () => {
  it('chat + сессия с project_id → source session', async () => {
    useSessionsStore.setState({ sessions: [{ id: 's1', project_id: 'p1' } as never] })
    setTabs([{ id: 'chat-s1', type: 'chat', title: 'c', data: { sessionId: 's1' } }], 'chat-s1')
    await renderProbe()

    expect(captured).toEqual({ projectId: 'p1', source: 'session', sessionId: 's1' })
  })

  it('chat + сессия без project_id → projectId null, source session', async () => {
    useSessionsStore.setState({ sessions: [{ id: 's2', project_id: null } as never] })
    setTabs([{ id: 'chat-s2', type: 'chat', title: 'c', data: { sessionId: 's2' } }], 'chat-s2')
    await renderProbe()

    expect(captured).toEqual({ projectId: null, source: 'session', sessionId: 's2' })
  })

  it('file-viewer → projectId вкладки, source file', async () => {
    setTabs([{ id: 'f1', type: 'file-viewer', title: 'a', data: { projectId: 'p2', filePath: 'a.ts' } }], 'f1')
    await renderProbe()

    expect(captured).toEqual({ projectId: 'p2', source: 'file', sessionId: null })
  })

  it('file-editor → projectId вкладки, source file', async () => {
    setTabs([{ id: 'e1', type: 'file-editor', title: 'a', data: { projectId: 'p9', filePath: 'a.ts' } }], 'e1')
    await renderProbe()

    expect(captured).toEqual({ projectId: 'p9', source: 'file', sessionId: null })
  })

  it('commit-detail → projectId вкладки, source commit', async () => {
    setTabs([{ id: 'c1', type: 'commit-detail', title: 'c', data: { projectId: 'p3', repoPath: '', commitHash: 'h' } }], 'c1')
    await renderProbe()

    expect(captured).toEqual({ projectId: 'p3', source: 'commit', sessionId: null })
  })

  it('нет активной вкладки → всё null', async () => {
    setTabs([], null)
    await renderProbe()

    expect(captured).toEqual({ projectId: null, source: null, sessionId: null })
  })

  it('сессия ещё не догружена → fallback на tab.data.projectId', async () => {
    useSessionsStore.setState({ sessions: [] })
    setTabs([{ id: 'chat-sx', type: 'chat', title: 'c', data: { sessionId: 'sx', projectId: 'pf' } }], 'chat-sx')
    await renderProbe()

    expect(captured).toEqual({ projectId: 'pf', source: 'session', sessionId: 'sx' })
  })
})
