import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

const apiMock = vi.hoisted(() => ({
  getContextFiles: vi.fn(),
  getContextFile: vi.fn(),
  saveContextFile: vi.fn(),
  toggleContextFile: vi.fn(),
  deleteContextFile: vi.fn(),
  resetContextFile: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({ synthApi: apiMock }))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { ContextPanel } from './ContextPanel'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const file = (name: string, category: string) => ({
  name,
  category,
  is_system: category !== 'user',
  is_overridden: false,
  enabled: true,
  size: 12,
})

const roots: Array<{ root: Root; container: HTMLElement }> = []

async function renderPanel(): Promise<HTMLElement> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <ContextPanel />
      </I18nProvider>,
    )
  })
  await act(async () => {})
  return container
}

beforeEach(() => {
  apiMock.getContextFiles.mockImplementation(async (category: string) => {
    if (category === 'role') return { files: [file('ROLE.md', 'role')] }
    if (category === 'system') return { files: [file('SYSTEM.md', 'system')] }
    return { files: [file('ABOUT.md', 'user')] }
  })
})

afterEach(async () => {
  while (roots.length > 0) {
    const { root, container } = roots.pop()!
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
  vi.clearAllMocks()
  document.body.innerHTML = ''
})

describe('ContextPanel — вкладки на Kit Tabs (ADR-072)', () => {
  it('рисует tablist с тремя вкладками и aria-label, активна User', async () => {
    const container = await renderPanel()

    const tablist = container.querySelector('[role="tablist"]')
    const tabs = container.querySelectorAll('[role="tab"]')
    expect(tablist).not.toBeNull()
    expect(tablist!.getAttribute('aria-label')).toBe('Context')
    expect(tabs).toHaveLength(3)
    expect(tabs[0]!.getAttribute('aria-selected')).toBe('true')
    expect(tabs[0]!.textContent).toBe('User')
    expect(container.textContent).toContain('ABOUT.md')

    // Счётчик — в `meta`, а не в сворачиваемом `description`.
    const meta = container.querySelector('[data-testid="settings-header-meta"]')
    expect(meta).not.toBeNull()
    expect(meta!.textContent).toContain('1')
    expect(container.querySelector('[data-testid="settings-header-description"]')).toBeNull()
  })

  it('клик по вкладке Roles переключает activeTab и грузит свою категорию', async () => {
    const container = await renderPanel()

    const rolesTab = container.querySelectorAll('[role="tab"]')[1] as HTMLButtonElement
    await act(async () => {
      rolesTab.click()
    })
    await act(async () => {})

    expect(apiMock.getContextFiles).toHaveBeenCalledWith('role')

    const tabs = container.querySelectorAll('[role="tab"]')
    expect(tabs[1]!.getAttribute('aria-selected')).toBe('true')
    expect(tabs[0]!.getAttribute('aria-selected')).toBe('false')
    expect(container.textContent).toContain('ROLE.md')
  })
})
