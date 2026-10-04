import { describe, it, expect, afterEach, vi } from 'vitest'
import { useState } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { PROJECT_COLORS } from '@/lib/projectMeta'
import { ColorPicker } from './ColorPicker'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

function Harness({ initialValue, onChange }: { initialValue?: string | null; onChange: (v: string) => void }) {
  const [value, setValue] = useState<string | null>(initialValue ?? null)
  return <ColorPicker value={value} onChange={(v) => { setValue(v); onChange(v) }} />
}

async function render(initialValue?: string | null): Promise<{ container: HTMLElement; onChange: ReturnType<typeof vi.fn> }> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  const onChange = vi.fn()
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <Harness initialValue={initialValue} onChange={onChange} />
      </I18nProvider>,
    )
  })
  return { container, onChange }
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

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

describe('ColorPicker — общая палитра темы (PROJECT_COLORS)', () => {
  it('рендерит все 16 цветов палитры и кнопку «без цвета»', async () => {
    const { container } = await render()

    expect(container.querySelectorAll('[data-testid^="agent-color-a"]')).toHaveLength(PROJECT_COLORS.length)
    expect(PROJECT_COLORS).toHaveLength(16)
    expect(container.querySelector('[data-testid="agent-color-none"]')).not.toBeNull()

    for (const { key } of PROJECT_COLORS) {
      expect(container.querySelector(`[data-testid="agent-color-${key}"]`), key).not.toBeNull()
    }
  })

  it('клик сохраняет имя CSS-переменной --palette-<индекс> (без var())', async () => {
    const { container, onChange } = await render()

    await click(container.querySelector('[data-testid="agent-color-a1"]')!)
    expect(onChange).toHaveBeenLastCalledWith('--palette-1')
    expect(container.querySelector('[data-testid="agent-color-a1"]')!.className).toContain('scale-110')

    await click(container.querySelector('[data-testid="agent-color-a16"]')!)
    expect(onChange).toHaveBeenLastCalledWith('--palette-16')
    expect(container.querySelector('[data-testid="agent-color-a16"]')!.className).toContain('scale-110')
  })

  it('значения палитры уникальны (нет повторов)', async () => {
    const { container, onChange } = await render()

    for (const { key } of PROJECT_COLORS) {
      await click(container.querySelector(`[data-testid="agent-color-${key}"]`)!)
    }
    const saved = onChange.mock.calls.map(([v]) => v as string)
    expect(saved).toHaveLength(PROJECT_COLORS.length)
    expect(new Set(saved).size).toBe(PROJECT_COLORS.length)
  })

  it('старое значение (--primary) не ломает рендер и не подсвечивает палитру', async () => {
    const { container } = await render('--primary')
    expect(container.querySelectorAll('[data-testid^="agent-color-a"]')).toHaveLength(PROJECT_COLORS.length)
    expect(container.querySelector('[data-testid="agent-color-a1"]')!.className).not.toContain('scale-110')
  })
})
