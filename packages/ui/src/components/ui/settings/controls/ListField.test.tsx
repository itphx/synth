import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'

import { ListField } from './ListField'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mounted: Array<{ root: Root; host: HTMLElement }> = []

async function renderList(props: React.ComponentProps<typeof ListField>): Promise<HTMLElement> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  mounted.push({ root, host })
  await act(async () => {
    root.render(
      <I18nProvider>
        <ListField {...props} />
      </I18nProvider>,
    )
  })
  return host
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

function buttonByText(host: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(host.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === text,
  )
  if (!button) throw new Error(`button "${text}" not found`)
  return button
}

function buttonsByText(host: HTMLElement, text: string): HTMLButtonElement[] {
  return Array.from(host.querySelectorAll('button')).filter(
    (b) => b.textContent?.trim() === text,
  ) as HTMLButtonElement[]
}

function StatefulList({
  initial,
  ...props
}: { initial: string[] } & Omit<React.ComponentProps<typeof ListField>, 'values' | 'onChange'>) {
  const [values, setValues] = React.useState(initial)
  return <ListField {...props} values={values} onChange={setValues} />
}

async function renderStatefulList(
  initial: string[],
  props: Omit<React.ComponentProps<typeof ListField>, 'values' | 'onChange'>,
): Promise<HTMLElement> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  mounted.push({ root, host })
  await act(async () => {
    root.render(
      <I18nProvider>
        <StatefulList initial={initial} {...props} />
      </I18nProvider>,
    )
  })
  return host
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

describe('ListField', () => {
  it('list: редактирование строки вызывает onChange', async () => {
    const onChange = vi.fn()
    const host = await renderList({ label: 'Paths', values: ['a'], onChange })

    const editable = host.querySelector('input') as HTMLInputElement
    await act(async () => {
      setInputValue(editable, 'ab')
    })

    expect(onChange).toHaveBeenCalledWith(['ab'])
  })

  it('list: удаление строки', async () => {
    const onChange = vi.fn()
    const host = await renderList({ label: 'Paths', values: ['a', 'b'], onChange })

    await act(async () => {
      buttonByText(host, 'Delete').click()
    })

    expect(onChange).toHaveBeenCalledWith(['b'])
  })

  it('list: кнопка «Добавить» добавляет пустую строку с кнопкой удаления', async () => {
    const host = await renderStatefulList(['a'], { label: 'Paths' })

    expect(host.querySelectorAll('input').length).toBe(1)
    expect(buttonsByText(host, 'Delete')).toHaveLength(1)

    await act(async () => {
      buttonByText(host, 'Add').click()
    })

    const inputs = host.querySelectorAll('input')
    expect(inputs.length).toBe(2)
    const added = inputs[inputs.length - 1] as HTMLInputElement
    expect(added.value).toBe('')
    // Новая строка сразу получает свою кнопку удаления.
    expect(buttonsByText(host, 'Delete')).toHaveLength(2)
  })

  it('list: при пустом списке нет постоянного поля ввода — только кнопка «Добавить»', async () => {
    const host = await renderList({ label: 'Paths', values: [], onChange: vi.fn() })

    expect(host.querySelectorAll('input').length).toBe(0)
    expect(host.querySelectorAll('button')).toHaveLength(1)
    expect(buttonByText(host, 'Add')).toBeDefined()
  })

  it('chips: рендерит чипы, удаляет по ×, добавляет из драфта', async () => {
    const onChange = vi.fn()
    const host = await renderList({
      label: 'Patterns',
      values: ['x', 'y'],
      onChange,
      variant: 'chips',
    })

    expect(host.textContent).toContain('x')
    expect(host.textContent).toContain('y')

    const remove = host.querySelector('button[aria-label="Delete x"]') as HTMLButtonElement
    await act(async () => {
      remove.click()
    })
    expect(onChange).toHaveBeenCalledWith(['y'])

    onChange.mockClear()
    const draftInput = host.querySelector('input') as HTMLInputElement
    await act(async () => {
      setInputValue(draftInput, 'z')
    })
    await act(async () => {
      buttonByText(host, 'Add').click()
    })
    expect(onChange).toHaveBeenCalledWith(['x', 'y', 'z'])
  })

  it('не переполняет контейнер: есть min-w-0; чипы — flex-wrap', async () => {
    const listHost = await renderList({ label: 'Paths', values: ['a'], onChange: vi.fn() })
    expect(listHost.querySelectorAll('.min-w-0').length).toBeGreaterThan(0)

    const chipsHost = await renderList({
      label: 'Patterns',
      values: ['a'],
      onChange: vi.fn(),
      variant: 'chips',
    })
    expect(chipsHost.querySelectorAll('.min-w-0').length).toBeGreaterThan(0)
    expect(chipsHost.querySelectorAll('.flex-wrap').length).toBeGreaterThan(0)
  })
})
