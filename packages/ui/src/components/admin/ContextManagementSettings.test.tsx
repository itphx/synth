import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

vi.mock('@/hooks/useNotification', () => ({
  useNotification: () => ({ notify: vi.fn() }),
}))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { TooltipProvider } from '@/components/ui/tooltip'
import { resetContextWindowPolicyCache } from '@/lib/api/contextWindowSettings'
import { ContextManagementSettings } from './ContextManagementSettings'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

const CONTEXT_DEFAULTS = {
  defaults: {
    contextOptimization: 'none',
    summarizationEnabled: false,
    summarizationTriggerMode: 'messages',
    summarizeAfterN: 20,
    summarizeTokenThreshold: 80,
    summarizationHeadMessages: 2,
    summarizationTailMessages: 4,
    slidingWindowMode: 'messages',
    slidingWindowMessageLimit: 20,
    slidingWindowTokenThreshold: 80,
  },
  saved: {},
  source: 'default',
  restartRequired: false,
}

const CONTEXT_WINDOW = {
  policy: 'warn',
  saved: null,
  defaults: 'warn',
  source: 'default',
  envLocked: false,
  restartRequired: false,
}

const STICKY_NOTES = {
  limits: { maxCount: 50, maxChars: 2000 },
  saved: null,
  defaults: { maxCount: 50, maxChars: 2000 },
  source: 'default',
  restartRequired: false,
}

function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      const body = url.endsWith('/settings/context-defaults')
        ? CONTEXT_DEFAULTS
        : url.endsWith('/settings/sticky-notes')
          ? STICKY_NOTES
          : CONTEXT_WINDOW
      return { ok: true, status: 200, json: async () => body } as unknown as Response
    }),
  )
}

async function renderPage(): Promise<HTMLElement> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <TooltipProvider>
          <ContextManagementSettings />
        </TooltipProvider>
      </I18nProvider>,
    )
  })
  await act(async () => {})
  await act(async () => {})
  return container
}

beforeEach(() => {
  resetContextWindowPolicyCache()
})

afterEach(async () => {
  while (roots.length > 0) {
    const { root, container } = roots.pop()!
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  resetContextWindowPolicyCache()
  document.body.innerHTML = ''
})

describe('ContextManagementSettings — страница', () => {
  it('один заголовок страницы и три блока: дефолты, политика и заметки', async () => {
    stubFetch()
    const container = await renderPage()

    const headings = Array.from(container.querySelectorAll('h2'))
    expect(headings).toHaveLength(1)
    expect(headings[0]?.textContent).toBe('Context management')

    expect(
      container.querySelector('[data-settings-section="context-defaults"]'),
    ).not.toBeNull()
    expect(
      container.querySelector('[data-settings-section="context-window-policy"]'),
    ).not.toBeNull()
    expect(
      container.querySelector('[data-settings-section="context-sticky-notes"]'),
    ).not.toBeNull()
    expect(container.textContent).toContain('Defaults for new sessions')
    expect(container.textContent).toContain('Context window policy')
    expect(container.textContent).toContain('Notes')

    // Политика встроена во встроенном режиме: три режима и источник на месте.
    expect(container.querySelectorAll('[role="radio"]')).toHaveLength(3)
    expect(container.querySelector('[data-testid="context-window-source-badge"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="context-defaults-source-badge"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="sticky-notes-source-badge"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="sticky-notes-max-count"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="sticky-notes-max-chars"]')).not.toBeNull()
  })
})
