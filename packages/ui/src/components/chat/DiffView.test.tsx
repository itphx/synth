import { describe, it, expect, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

vi.mock('@/lib/i18n', () => ({
  useI18n: () => ({ t: (key: string) => key, locale: 'ru', locales: ['ru'], setLocale: () => {} }),
}))

import { DiffView, parseDiff } from './DiffView'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

async function render(node: React.ReactNode): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(node)
  })
  await act(async () => {})
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
})

const DIFF = ['@@ -1 +1 @@', '-old', '+new', ' ctx'].join('\n')

describe('DiffView — варианты inline/page', () => {
  it('parseDiff размечает заголовок, добавление, удаление и контекст', () => {
    expect(parseDiff(DIFF)).toEqual([
      { type: 'header', text: '@@ -1 +1 @@' },
      { type: 'remove', text: '-old' },
      { type: 'add', text: '+new' },
      { type: 'context', text: ' ctx' },
    ])
  })

  it('inline (дефолт) — прежняя разметка карточек с классами .diff-*', async () => {
    const container = await render(<DiffView diff={DIFF} />)
    const pre = container.querySelector('pre')!

    // Ровно прежний вид карточки: без паддинга, компактный шрифт.
    expect(pre.className).toContain('text-[0.6875rem]')
    expect(pre.className).toContain('p-0')

    expect(container.querySelector('.diff-header')!.textContent).toBe('@@ -1 +1 @@')
    expect(container.querySelector('.diff-removed')!.textContent).toBe('-old')
    expect(container.querySelector('.diff-added')!.textContent).toBe('+new')
    // Плюс/минус не дублируются токенами темы — цвета дают классы `.diff-*`.
    expect(pre.className).not.toContain('p-4')
  })

  it('page — отступы и токены темы', async () => {
    const container = await render(<DiffView diff={DIFF} variant="page" testId="d" />)
    const pre = container.querySelector('[data-testid="d"]')!

    expect(pre.tagName).toBe('PRE')
    expect(pre.className).toContain('p-4')
    expect(pre.querySelector('.text-status-success')!.textContent).toContain('+new')
    expect(pre.querySelector('.text-status-error')!.textContent).toContain('-old')
    expect(pre.querySelector('.diff-added')).toBeNull()
  })

  it('page: пустой diff — пустое состояние', async () => {
    const container = await render(<DiffView diff="" variant="page" testId="d" emptyText="нет" />)
    expect(container.querySelector('[data-testid="d-empty"]')!.textContent).toBe('нет')
    expect(container.querySelector('pre')).toBeNull()
  })

  it('обрезанный diff: плашка в обоих вариантах, строки ограничены', async () => {
    const big = Array.from({ length: 50 }, (_, i) => `+line ${i}`).join('\n')

    const page = await render(
      <DiffView diff={big} variant="page" truncated maxLines={5} testId="p" truncatedTestId="p-trunc" />,
    )
    expect(page.querySelector('[data-testid="p-trunc"]')).not.toBeNull()
    expect(page.querySelector('[data-testid="p"]')!.textContent!.split('\n').filter(Boolean).length).toBe(5)

    const inline = await render(
      <DiffView diff={big} truncated maxLines={3} testId="i" truncatedTestId="i-trunc" />,
    )
    expect(inline.querySelector('[data-testid="i-trunc"]')).not.toBeNull()
    expect(inline.querySelectorAll('.diff-added').length).toBe(3)
  })
})
