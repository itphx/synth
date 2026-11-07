import { describe, it, expect, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { MarkdownText } from './MarkdownText'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

async function render(node: React.ReactNode): Promise<HTMLElement> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(<I18nProvider>{node}</I18nProvider>)
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
})

describe('MarkdownText: plain-превью и полный рендер', () => {
  it('plain: разметка снимается, текст остаётся', async () => {
    const container = await render(
      <MarkdownText content={'**жирный** и `код`'} mode="plain" testId="md" />,
    )
    const node = container.querySelector('[data-testid="md"]')!
    expect(node.getAttribute('data-markdown-mode')).toBe('plain')
    expect(node.textContent).toContain('жирный')
    expect(node.textContent).toContain('код')
    expect(node.textContent).not.toContain('**')
    expect(node.textContent).not.toContain('`')
    // В plain-режиме HTML-разметки быть не должно вовсе.
    expect(node.querySelector('strong')).toBeNull()
  })

  it('render: markdown рендерится через MarkdownContent (marked + DOMPurify)', async () => {
    const container = await render(
      <MarkdownText content={'**жирный**'} mode="render" testId="md" />,
    )
    const node = container.querySelector('[data-testid="md"]')!
    expect(node.getAttribute('data-markdown-mode')).toBe('render')
    expect(node.querySelector('.markdown-content')).not.toBeNull()
    expect(node.querySelector('strong')?.textContent).toBe('жирный')
  })

  it('render: опасные атрибуты сырого HTML вырезаются санитайзером', async () => {
    const container = await render(
      <MarkdownText content={'<img src="x" onerror="alert(1)"> текст'} mode="render" testId="md" />,
    )
    const node = container.querySelector('[data-testid="md"]')!
    const img = node.querySelector('img')
    expect(img?.getAttribute('onerror')).toBeNull()
    expect(node.textContent).toContain('текст')
  })

  it('plain: превью обрезается по maxLength с многоточием', async () => {
    const container = await render(
      <MarkdownText content={'a'.repeat(50)} mode="plain" maxLength={10} testId="md" />,
    )
    const node = container.querySelector('[data-testid="md"]')!
    expect(node.textContent).toBe(`${'a'.repeat(10)}…`)
  })

  it('пустой текст не рисует ничего', async () => {
    const container = await render(<MarkdownText content="   " mode="plain" testId="md" />)
    expect(container.querySelector('[data-testid="md"]')).toBeNull()
  })
})
