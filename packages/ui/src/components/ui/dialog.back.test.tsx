import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

// Base UI (floating-ui) создаёт ResizeObserver — в jsdom его нет.
vi.hoisted(() => {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.defineProperty(globalThis, 'ResizeObserver', {
    value: ResizeObserverStub,
    configurable: true,
  })
  if (typeof window !== 'undefined') {
    Object.defineProperty(window, 'ResizeObserver', {
      value: ResizeObserverStub,
      configurable: true,
    })
  }
})

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { Dialog, DialogContent } from './dialog'
import { __resetBackCloseForTests } from '@/hooks/useBackClose'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

function overlayId(): unknown {
  return (window.history.state as Record<string, unknown> | null)?.synthBackOverlay
}

async function renderDialog(
  open: boolean,
  onOpenChange: (open: boolean) => void,
): Promise<{
  root: Root
  container: HTMLElement
  render: (open: boolean) => Promise<void>
}> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  const render = async (nextOpen: boolean) => {
    await act(async () => {
      root.render(
        <I18nProvider>
          <Dialog open={nextOpen} onOpenChange={onOpenChange}>
            <DialogContent>Тело диалога</DialogContent>
          </Dialog>
        </I18nProvider>,
      )
    })
    await act(async () => {})
  }
  await render(open)
  return { root, container, render }
}

let backSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  __resetBackCloseForTests()
  window.history.replaceState({}, '')
  backSpy = vi.spyOn(window.history, 'back').mockImplementation(() => {})
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
  __resetBackCloseForTests()
  window.history.replaceState({}, '')
  backSpy.mockRestore()
})

describe('Dialog: кнопка «назад» закрывает верхний оверлей', () => {
  it('открытый диалог кладёт запись истории', async () => {
    await renderDialog(true, () => {})
    expect(overlayId()).toEqual(expect.any(Number))
  })

  it('popstate → onOpenChange(false)', async () => {
    const onOpenChange = vi.fn()
    await renderDialog(true, onOpenChange)

    await act(async () => {
      window.dispatchEvent(new PopStateEvent('popstate'))
    })

    expect(onOpenChange).toHaveBeenCalledWith(false, expect.anything())
  })

  it('программное закрытие (open=false) → history.back один раз', async () => {
    const onOpenChange = vi.fn()
    const { render } = await renderDialog(true, onOpenChange)

    await render(false)

    expect(backSpy).toHaveBeenCalledTimes(1)
  })

  it('закрытый диалог не регистрируется в истории', async () => {
    await renderDialog(false, () => {})
    expect(overlayId()).toBeUndefined()
  })
})
