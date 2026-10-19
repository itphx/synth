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
import { useUIStore } from '@/stores/useUIStore'
import { ChatSettings } from './ChatSettings'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

async function renderSettings(): Promise<HTMLElement> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <TooltipProvider>
          <ChatSettings />
        </TooltipProvider>
      </I18nProvider>,
    )
  })
  await act(async () => {})
  return container
}

async function unmountOne(container: HTMLElement) {
  const idx = roots.findIndex((r) => r.container === container)
  if (idx < 0) return
  const [{ root, container: c }] = roots.splice(idx, 1)
  await act(async () => {
    root.unmount()
  })
  c.remove()
}

const byTestId = (container: HTMLElement, id: string) =>
  container.querySelector(`[data-testid="${id}"]`) as HTMLButtonElement | null

const radioByText = (container: HTMLElement, text: string) =>
  Array.from(container.querySelectorAll('[role="radio"]')).find(
    (r) => r.textContent?.trim() === text,
  ) as HTMLButtonElement

beforeEach(() => {
  useUIStore.setState({ intermediateTextDisplay: 'inline' })
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
})

describe('ChatSettings — миграция на Settings UI Kit (ADR-072)', () => {
  it('каркас — SettingsPanel с единственным scroll-контейнером и без pr-2', async () => {
    const container = await renderSettings()

    const scrollers = container.querySelectorAll('.overflow-y-auto')
    expect(scrollers).toHaveLength(1)
    expect(scrollers[0]!.classList.contains('overflow-x-hidden')).toBe(true)
    expect(container.innerHTML).not.toContain('pr-2')
  })

  it('нет grid без базового grid-cols-1', async () => {
    const container = await renderSettings()
    container.querySelectorAll('.grid').forEach((el) => {
      expect(el.classList.contains('grid-cols-1')).toBe(true)
    })
  })

  it('выбор меняет черновик, но не стор до Save', async () => {
    const container = await renderSettings()

    expect(container.textContent).toContain('Intermediate responses')
    await act(async () => {
      radioByText(container, 'At bottom').click()
    })

    expect(radioByText(container, 'At bottom').getAttribute('aria-checked')).toBe('true')
    expect(useUIStore.getState().intermediateTextDisplay).toBe('inline')

    await act(async () => {
      byTestId(container, 'chat-save')!.click()
    })
    expect(useUIStore.getState().intermediateTextDisplay).toBe('bottom')
  })

  it('Cancel возвращает сохранённый выбор', async () => {
    const container = await renderSettings()

    await act(async () => {
      radioByText(container, 'At bottom').click()
    })
    await act(async () => {
      byTestId(container, 'chat-cancel')!.click()
    })

    expect(radioByText(container, 'Between blocks').getAttribute('aria-checked')).toBe('true')
    expect(useUIStore.getState().intermediateTextDisplay).toBe('inline')
  })

  it('Reset сбрасывает черновик к inline, персист — только по Save', async () => {
    useUIStore.setState({ intermediateTextDisplay: 'bottom' })
    const container = await renderSettings()

    await act(async () => {
      byTestId(container, 'chat-reset')!.click()
    })

    expect(radioByText(container, 'Between blocks').getAttribute('aria-checked')).toBe('true')
    expect(useUIStore.getState().intermediateTextDisplay).toBe('bottom')

    await act(async () => {
      byTestId(container, 'chat-save')!.click()
    })
    expect(useUIStore.getState().intermediateTextDisplay).toBe('inline')
  })

  it('закрытие (unmount) не персистит черновик', async () => {
    const container = await renderSettings()

    await act(async () => {
      radioByText(container, 'At bottom').click()
    })
    await unmountOne(container)

    expect(useUIStore.getState().intermediateTextDisplay).toBe('inline')
  })

  it('Reset серый/неактивен на дефолте и активен при изменениях', async () => {
    const container = await renderSettings()

    expect(byTestId(container, 'chat-reset')!.disabled).toBe(true)
    expect(byTestId(container, 'chat-reset')!.className).toContain('border-muted-foreground')

    await act(async () => {
      radioByText(container, 'At bottom').click()
    })

    expect(byTestId(container, 'chat-reset')!.disabled).toBe(false)
    expect(byTestId(container, 'chat-reset')!.className).toContain('border-primary')
  })
})
