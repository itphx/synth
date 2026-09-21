import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'

import { SettingsActions } from './SettingsActions'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mounted: Array<{ root: Root; host: HTMLElement }> = []

async function renderActions(
  props: React.ComponentProps<typeof SettingsActions>,
): Promise<HTMLElement> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  mounted.push({ root, host })
  await act(async () => {
    root.render(
      <I18nProvider>
        <SettingsActions {...props} />
      </I18nProvider>,
    )
  })
  return host
}

function buttonByText(host: HTMLElement, text: string): HTMLButtonElement | undefined {
  return Array.from(host.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === text,
  ) as HTMLButtonElement | undefined
}

beforeEach(() => {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
})

afterEach(async () => {
  while (mounted.length > 0) {
    const entry = mounted.pop()!
    await act(async () => {
      entry.root.unmount()
    })
    entry.host.remove()
  }
  document.body.innerHTML = ''
})

describe('SettingsActions', () => {
  it('вызывает onSave/onCancel/onReset', async () => {
    const onSave = vi.fn()
    const onCancel = vi.fn()
    const onReset = vi.fn()
    const host = await renderActions({ onSave, onCancel, onReset })

    await act(async () => {
      buttonByText(host, 'Save')!.click()
      buttonByText(host, 'Cancel')!.click()
      buttonByText(host, 'Reset')!.click()
    })

    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onReset).toHaveBeenCalledTimes(1)
  })

  it('Reset не рендерится без onReset', async () => {
    const host = await renderActions({ onSave: vi.fn(), onCancel: vi.fn() })
    expect(buttonByText(host, 'Reset')).toBeUndefined()
    expect(buttonByText(host, 'Save')).toBeDefined()
    expect(buttonByText(host, 'Cancel')).toBeDefined()
  })

  it('disabled блокирует все кнопки', async () => {
    const onSave = vi.fn()
    const host = await renderActions({
      onSave,
      onCancel: vi.fn(),
      onReset: vi.fn(),
      disabled: true,
    })

    for (const label of ['Save', 'Cancel', 'Reset']) {
      expect(buttonByText(host, label)!.disabled).toBe(true)
    }
    await act(async () => {
      buttonByText(host, 'Save')!.click()
    })
    expect(onSave).not.toHaveBeenCalled()
  })

  it('saving блокирует Save и меняет подпись', async () => {
    const host = await renderActions({
      onSave: vi.fn(),
      onCancel: vi.fn(),
      saving: true,
    })

    const save = buttonByText(host, 'Saving...')
    expect(save).toBeDefined()
    expect(save!.disabled).toBe(true)
    expect(buttonByText(host, 'Cancel')!.disabled).toBe(false)
  })

  it('saveDisabled блокирует только Save', async () => {
    const host = await renderActions({
      onSave: vi.fn(),
      onCancel: vi.fn(),
      onReset: vi.fn(),
      saveDisabled: true,
    })

    expect(buttonByText(host, 'Save')!.disabled).toBe(true)
    expect(buttonByText(host, 'Cancel')!.disabled).toBe(false)
    expect(buttonByText(host, 'Reset')!.disabled).toBe(false)
  })

  it('пользовательские подписи переопределяют i18n-дефолты', async () => {
    const host = await renderActions({
      onSave: vi.fn(),
      saveLabel: 'Apply',
    })
    expect(buttonByText(host, 'Apply')).toBeDefined()
  })
})
