import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

// persist (zustand) в useUIStore/notificationStore пишет в localStorage — в Node/vitest его нет.
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

const mocks = vi.hoisted(() => ({ notify: vi.fn() }))

vi.mock('@/hooks/useNotification', () => ({ useNotification: () => ({ notify: mocks.notify }) }))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { usePanelSettingSave, type PanelSettingSave } from './usePanelSettingSave'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

let api: PanelSettingSave

function Probe({ throttleMs }: { throttleMs?: number }) {
  api = usePanelSettingSave({ throttleMs })
  return null
}

async function renderProbe(throttleMs?: number): Promise<void> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <Probe throttleMs={throttleMs} />
      </I18nProvider>,
    )
  })
}

beforeEach(() => {
  mocks.notify.mockClear()
})

afterEach(async () => {
  while (roots.length > 0) {
    const { root, container } = roots.pop()!
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
  vi.restoreAllMocks()
})

describe('usePanelSettingSave', () => {
  it('success: throttled-тост panel.saved и возврат результата', async () => {
    await renderProbe()
    let result: number | undefined
    await act(async () => {
      result = await api.run({ key: 'k', run: async () => 7 })
    })
    expect(result).toBe(7)
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({ text: enDict['panel.saved'], type: 'success' }),
    )
  })

  it('только первый success в окне троттлинга показывает тост', async () => {
    await renderProbe(1500)
    await act(async () => {
      await api.run({ key: 'a', run: async () => 1 })
    })
    await act(async () => {
      await api.run({ key: 'b', run: async () => 2 })
    })
    expect(mocks.notify).toHaveBeenCalledTimes(1)
  })

  it('после окна троттлинга success-тост показывается снова', async () => {
    let now = 1_000_000
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => now)
    await renderProbe(1500)
    await act(async () => {
      await api.run({ key: 'a', run: async () => 1 })
    })
    now += 1600
    await act(async () => {
      await api.run({ key: 'b', run: async () => 2 })
    })
    expect(mocks.notify).toHaveBeenCalledTimes(2)
    spy.mockRestore()
  })

  it('error: тост panel.saveError, onError и возврат undefined', async () => {
    await renderProbe()
    const onError = vi.fn()
    const boom = new Error('boom')
    let result: unknown = 'sentinel'
    await act(async () => {
      result = await api.run({
        key: 'k',
        run: async () => {
          throw boom
        },
        onError,
      })
    })
    expect(result).toBeUndefined()
    expect(onError).toHaveBeenCalledWith(boom)
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({ text: enDict['panel.saveError'], type: 'error' }),
    )
  })

  it('errorKey-функция выбирает специальный текст ошибки', async () => {
    await renderProbe()
    await act(async () => {
      await api.run({
        key: 'k',
        run: async () => {
          throw Object.assign(new Error('forbidden'), { status: 403 })
        },
        errorKey: (err) => ((err as { status?: number }).status === 403 ? 'projectTab.skills.forbidden' : 'panel.saveError'),
      })
    })
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({ text: enDict['projectTab.skills.forbidden'], type: 'error' }),
    )
  })

  it('pending по ключу ставится и снимается', async () => {
    await renderProbe()
    let resolveTask!: (value: number) => void
    let runPromise!: Promise<number | undefined>
    await act(async () => {
      runPromise = api.run({
        key: 'k',
        run: () => new Promise<number>((resolve) => { resolveTask = resolve }),
      })
    })
    expect(api.isPending('k')).toBe(true)
    expect(api.isPending('other')).toBe(false)
    expect(api.pendingKeys.has('k')).toBe(true)

    await act(async () => {
      resolveTask(1)
      await runPromise
    })
    expect(api.isPending('k')).toBe(false)
    expect(api.pendingKeys.size).toBe(0)
  })

  it('error-тосты не троттлятся', async () => {
    await renderProbe(60_000)
    await act(async () => {
      await api.run({ key: 'a', run: async () => { throw new Error('one') } })
    })
    await act(async () => {
      await api.run({ key: 'b', run: async () => { throw new Error('two') } })
    })
    expect(mocks.notify).toHaveBeenCalledTimes(2)
  })
})
