import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'

import { KeyValueField } from './KeyValueField'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mounted: Array<{ root: Root; host: HTMLElement }> = []

async function renderField(
  props: React.ComponentProps<typeof KeyValueField>,
): Promise<HTMLElement> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  mounted.push({ root, host })
  await act(async () => {
    root.render(
      <I18nProvider>
        <KeyValueField {...props} />
      </I18nProvider>,
    )
  })
  return host
}

function StatefulField({
  initial,
  ...props
}: { initial: Record<string, string> } & Omit<
  React.ComponentProps<typeof KeyValueField>,
  'value' | 'onChange'
>) {
  const [value, setValue] = React.useState(initial)
  return <KeyValueField {...props} value={value} onChange={setValue} />
}

async function renderStatefulField(
  initial: Record<string, string>,
  props: Omit<React.ComponentProps<typeof KeyValueField>, 'value' | 'onChange'>,
): Promise<HTMLElement> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  mounted.push({ root, host })
  await act(async () => {
    root.render(
      <I18nProvider>
        <StatefulField initial={initial} {...props} />
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

describe('KeyValueField', () => {
  it('рендерит пары из value (ключ/значение на строку)', async () => {
    const host = await renderField({
      label: 'Mapping',
      value: { 'chat:telegram:1': 'u1', 'tg:2': 'u2' },
      onChange: vi.fn(),
    })

    const inputs = host.querySelectorAll('input') as NodeListOf<HTMLInputElement>
    expect(inputs).toHaveLength(4)
    expect(Array.from(inputs).map((i) => i.value)).toEqual([
      'chat:telegram:1',
      'u1',
      'tg:2',
      'u2',
    ])
    expect(buttonsByText(host, 'Delete')).toHaveLength(2)
  })

  it('изменение значения вызывает onChange с корректным объектом', async () => {
    const onChange = vi.fn()
    const host = await renderField({
      label: 'Mapping',
      value: { 'chat:telegram:1': 'u1' },
      onChange,
    })

    const inputs = host.querySelectorAll('input') as NodeListOf<HTMLInputElement>
    await act(async () => {
      setInputValue(inputs[1], 'u9')
    })

    expect(onChange).toHaveBeenCalledWith({ 'chat:telegram:1': 'u9' })
  })

  it('изменение ключа вызывает onChange с новым ключом (порядок сохранён)', async () => {
    const onChange = vi.fn()
    const host = await renderField({
      label: 'Mapping',
      value: { a: '1', b: '2' },
      onChange,
    })

    const inputs = host.querySelectorAll('input') as NodeListOf<HTMLInputElement>
    await act(async () => {
      setInputValue(inputs[2], 'c')
    })

    expect(onChange).toHaveBeenCalledWith({ a: '1', c: '2' })
  })

  it('удаление строки убирает пару и сохраняет остальные', async () => {
    const onChange = vi.fn()
    const host = await renderField({
      label: 'Mapping',
      value: { a: '1', b: '2' },
      onChange,
    })

    await act(async () => {
      buttonsByText(host, 'Delete')[0].click()
    })

    expect(onChange).toHaveBeenCalledWith({ b: '2' })
  })

  it('кнопка «Добавить» добавляет пустую строку парой инпутов', async () => {
    const host = await renderStatefulField({ a: '1' }, { label: 'Mapping' })

    expect(host.querySelectorAll('input')).toHaveLength(2)
    expect(buttonsByText(host, 'Delete')).toHaveLength(1)

    await act(async () => {
      buttonByText(host, 'Add').click()
    })

    const inputs = host.querySelectorAll('input') as NodeListOf<HTMLInputElement>
    expect(inputs).toHaveLength(4)
    expect(inputs[2].value).toBe('')
    expect(inputs[3].value).toBe('')
    // Новая строка сразу получает свою кнопку удаления.
    expect(buttonsByText(host, 'Delete')).toHaveLength(2)
  })

  it('пустое состояние: только текст и кнопка «Добавить»', async () => {
    const host = await renderField({ label: 'Mapping', value: {}, onChange: vi.fn() })

    expect(host.querySelectorAll('input')).toHaveLength(0)
    expect(buttonsByText(host, 'Delete')).toHaveLength(0)
    expect(host.textContent).toContain('Empty')
    expect(buttonByText(host, 'Add')).toBeDefined()
  })

  it('дублирующийся ключ не схлопывает строки, наружу уходит последнее значение', async () => {
    const host = await renderStatefulField(
      { a: '1', b: '2' },
      { label: 'Mapping' },
    )

    const inputs = host.querySelectorAll('input') as NodeListOf<HTMLInputElement>
    await act(async () => {
      setInputValue(inputs[2], 'a')
    })

    // Обе строки на месте; значение — от последней.
    expect(host.querySelectorAll('input')).toHaveLength(4)
    const after = host.querySelectorAll('input') as NodeListOf<HTMLInputElement>
    expect(after[0].value).toBe('a')
    expect(after[2].value).toBe('a')
  })

  it('внешнее изменение value пересобирает строки (не эхо своей эмиссии)', async () => {
    // Контролируемый родитель: значение задаётся извне, а не через onChange.
    const externals: Array<(v: Record<string, string>) => void> = []
    function ControlledParent() {
      const [value, setValue] = React.useState<Record<string, string>>({ a: '1' })
      externals.push(setValue)
      return <KeyValueField label="Mapping" value={value} onChange={vi.fn()} />
    }

    useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    mounted.push({ root, host })
    await act(async () => {
      root.render(
        <I18nProvider>
          <ControlledParent />
        </I18nProvider>,
      )
    })

    expect(
      Array.from(host.querySelectorAll('input') as NodeListOf<HTMLInputElement>).map((i) => i.value),
    ).toEqual(['a', '1'])

    await act(async () => {
      externals[0]({ x: '9', y: '2' })
    })

    expect(
      Array.from(host.querySelectorAll('input') as NodeListOf<HTMLInputElement>).map((i) => i.value),
    ).toEqual(['x', '9', 'y', '2'])
  })

  it('a11y: у инпутов и кнопки удаления есть aria-label', async () => {
    const host = await renderField({
      label: 'Mapping',
      value: { a: '1' },
      onChange: vi.fn(),
    })

    const inputs = host.querySelectorAll('input') as NodeListOf<HTMLInputElement>
    expect(inputs[0].getAttribute('aria-label')).toBe('Key')
    expect(inputs[1].getAttribute('aria-label')).toBe('Value')
    expect(buttonsByText(host, 'Delete')[0].getAttribute('aria-label')).toBe('Delete')
  })

  it('не переполняет контейнер: есть min-w-0', async () => {
    const host = await renderField({
      label: 'Mapping',
      value: { a: '1' },
      onChange: vi.fn(),
    })
    expect(host.querySelectorAll('.min-w-0').length).toBeGreaterThan(0)
  })
})
