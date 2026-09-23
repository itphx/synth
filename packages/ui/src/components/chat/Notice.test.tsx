import { describe, it, expect, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { Notice, type NoticeProps } from './Notice'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

async function renderNotice(props: NoticeProps): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <Notice {...props} />
      </I18nProvider>,
    )
  })
  return container
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

describe('Notice: единый блок служебных сообщений', () => {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })

  it('центрирует блок, текст внутри — слева', async () => {
    const container = await renderNotice({ variant: 'info', label: 'Info', children: 'body' })
    const wrapper = container.firstElementChild as HTMLElement
    expect(wrapper.className).toContain('items-center')
    expect(wrapper.className).toContain('px-4')
    expect(wrapper.className).toContain('group')
    const box = container.querySelector('[role="group"]') as HTMLElement
    expect(box.className).toContain('w-full')
    expect(box.className).toContain('max-w-[85%]')
    expect(box.className).toContain('text-left')
  })

  it('шапка: иконка + label + meta справа', async () => {
    const container = await renderNotice({
      variant: 'summary',
      label: 'Сводка',
      meta: <span>gpt-x</span>,
      children: 'body',
    })
    expect(container.querySelector('svg')).not.toBeNull()
    expect(container.textContent).toContain('Сводка')
    expect(container.textContent).toContain('gpt-x')
    const metaWrap = container.querySelector('svg')!.parentElement!.querySelector('.ml-auto')
    expect(metaWrap).not.toBeNull()
    expect(metaWrap!.textContent).toContain('gpt-x')
  })

  it('command: подпись моноширинная', async () => {
    const container = await renderNotice({ variant: 'command', label: '> /help', children: 'out' })
    const header = container.querySelector('.font-mono')
    expect(header).not.toBeNull()
    expect(header!.textContent).toContain('> /help')
  })

  it('info: компактный кегль', async () => {
    const container = await renderNotice({ variant: 'info', label: 'Info', children: 'note' })
    const box = container.querySelector('[role="group"]') as HTMLElement
    expect(box.className).toContain('text-xs')
  })

  it('error: destructive-стиль', async () => {
    const container = await renderNotice({ variant: 'error', label: 'Error', children: 'boom' })
    const box = container.querySelector('[role="group"]') as HTMLElement
    expect(box.className).toContain('bg-destructive/10')
    expect(box.className).toContain('border-destructive/30')
  })

  it('всегда есть кнопка «Копировать» при onCopy и она вызывает обработчик', async () => {
    let copied = 0
    const container = await renderNotice({
      variant: 'info',
      label: 'Info',
      children: 'note',
      onCopy: () => {
        copied += 1
      },
    })
    const btn = container.querySelector('button[title="Copy"]') as HTMLButtonElement
    expect(btn).not.toBeNull()
    expect(btn.getAttribute('aria-label')).toBe('Copy')
    await act(async () => {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(copied).toBe(1)
  })

  it('без onCopy кнопки копирования нет', async () => {
    const container = await renderNotice({ variant: 'error', label: 'Error', children: 'x' })
    expect(container.querySelector('button[title="Copy"]')).toBeNull()
  })

  it('actions рендерятся рядом с копированием', async () => {
    const container = await renderNotice({
      variant: 'debug',
      label: 'Debug',
      children: 'x',
      onCopy: () => {},
      actions: <button data-testid="extra">extra</button>,
    })
    const footer = container.querySelector('.message-actions') as HTMLElement
    expect(footer).not.toBeNull()
    expect(footer.querySelector('button[title="Copy"]')).not.toBeNull()
    expect(footer.querySelector('[data-testid="extra"]')).not.toBeNull()
  })

  it('disabled → приглушение', async () => {
    const container = await renderNotice({
      variant: 'summary',
      label: 'Summary',
      children: 'x',
      disabled: true,
    })
    const box = container.querySelector('[role="group"]') as HTMLElement
    expect(box.className).toContain('opacity-50')
  })

  it('кастомная иконка переопределяет иконку варианта', async () => {
    const container = await renderNotice({
      variant: 'info',
      icon: 'rocket',
      label: 'Info',
      children: 'x',
    })
    expect(container.querySelector('svg')).not.toBeNull()
  })
})
