import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
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

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { TooltipProvider } from '@/components/ui/tooltip'
import { CenterTabs } from './CenterTabs'
import { useUIStore } from '@/stores/useUIStore'
import { useSessionsStore } from '@/stores/sessionsStore'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// jsdom не реализует scrollIntoView — его зовёт эффект CenterTabs.
if (typeof Element !== 'undefined' && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {}
}

const roots: Array<{ root: Root; container: HTMLElement }> = []

async function renderTabs(): Promise<HTMLElement> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <TooltipProvider>
          <CenterTabs />
        </TooltipProvider>
      </I18nProvider>,
    )
  })
  await act(async () => {})
  return container
}

function tabIconColor(container: HTMLElement, tabId: string): string {
  const svg = container.querySelector(`[data-tab-id="${tabId}"] svg`) as SVGElement | null
  expect(svg, `иконка таба ${tabId}`).not.toBeNull()
  return svg!.style.color
}

beforeEach(() => {
  useUIStore.setState({
    activeCenterTabId: 'tab-1',
    centerTabs: [
      { id: 'tab-1', type: 'chat', title: 'Chat', data: { sessionId: 's1' } },
      { id: 'tab-2', type: 'file-viewer', title: 'File', data: { filePath: '/a.ts' } },
    ],
  })
  useSessionsStore.setState({
    sessions: [{ id: 's1', name: 'S', project_id: null, engine: 'synth' }],
  } as never)
})

afterEach(async () => {
  while (roots.length > 0) {
    const { root, container } = roots.pop()!
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
  document.body.innerHTML = ''
  vi.clearAllMocks()
})

describe('CenterTabs — цвет иконки сессионного таба', () => {
  it('при пустом session.color иконка таба сессии — --primary', async () => {
    const container = await renderTabs()
    expect(tabIconColor(container, 'tab-1')).toBe('var(--primary)')
  })

  it('заданный session.color определяет цвет иконки таба', async () => {
    useSessionsStore.setState({
      sessions: [{ id: 's1', name: 'S', project_id: null, engine: 'synth', color: 'success' }],
    } as never)
    const container = await renderTabs()
    expect(tabIconColor(container, 'tab-1')).toBe('var(--status-success)')
  })

  it('инлайн-цвет не зависит от активности таба (неактивный таб сессии тоже --primary)', async () => {
    useUIStore.setState({
      activeCenterTabId: 'tab-2',
      centerTabs: [
        { id: 'tab-1', type: 'chat', title: 'Chat', data: { sessionId: 's1' } },
        { id: 'tab-2', type: 'file-viewer', title: 'File', data: { filePath: '/a.ts' } },
      ],
    })
    const container = await renderTabs()
    expect(tabIconColor(container, 'tab-1')).toBe('var(--primary)')
  })

  it('не-сессионный таб рендерится без inline-цвета (нейтральный)', async () => {
    const container = await renderTabs()
    expect(tabIconColor(container, 'tab-2')).toBe('')
  })
})
