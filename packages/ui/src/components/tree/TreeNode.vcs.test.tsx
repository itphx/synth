import { describe, it, expect, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

vi.mock('@/lib/i18n', () => ({
  useI18n: () => ({ t: (key: string) => key, locale: 'ru', locales: ['ru'], setLocale: () => {} }),
}))

import { TreeNode } from './TreeNode'
import type { TreeNodeBase } from './types'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

async function render(node: TreeNodeBase): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(<TreeNode {...node} />)
  })
  await act(async () => {})
  return container
}

/** Название узла: span с текстом и обрезкой (не точка и не бейдж). */
function labelOf(container: HTMLElement, label: string): HTMLElement {
  const span = [...container.querySelectorAll('span')].find(
    (s) => s.textContent === label && s.className.includes('truncate'),
  )
  return span as HTMLElement
}

afterEach(async () => {
  while (roots.length > 0) {
    const { root, container } = roots.pop()!
    await act(async () => { root.unmount() })
    container.remove()
  }
})

describe('TreeNode — статус VCS (ADR-076, этап 1)', () => {
  it('для modified рисует оранжевую точку и жёлтое название', async () => {
    const container = await render({ id: 'n1', label: 'a.ts', vcsStatus: 'modified' })

    const dot = container.querySelector('[data-vcs-dot="modified"]')
    expect(dot).not.toBeNull()
    expect(dot!.className).toContain('bg-status-caution')
    expect(dot!.className).toContain('h-1.5')
    expect(dot!.className).toContain('w-1.5')
    expect(dot!.getAttribute('aria-label')).toBe('file.vcs.modified')
    expect(dot!.getAttribute('title')).toBe('file.vcs.modified')

    const label = labelOf(container, 'a.ts')
    expect(label.className).toContain('text-status-caution')
  })

  it('точка стоит справа от имени (сразу после названия, до бейджа)', async () => {
    const container = await render({
      id: 'n-order',
      label: 'a.ts',
      vcsStatus: 'modified',
      badge: <span data-testid="badge">3</span>,
    })

    const label = labelOf(container, 'a.ts')
    const dot = container.querySelector<HTMLElement>('[data-vcs-dot="modified"]')!
    const badge = container.querySelector<HTMLElement>('[data-testid="badge"]')!

    expect(label.nextElementSibling).toBe(dot)
    expect(dot.nextElementSibling).toBe(badge)
  })

  it('для added — зелёная точка и зелёное название', async () => {
    const container = await render({ id: 'n2', label: 'b.ts', vcsStatus: 'added' })
    expect(container.querySelector('[data-vcs-dot="added"]')!.className).toContain('bg-status-success')
    expect(labelOf(container, 'b.ts').className).toContain('text-status-success')
  })

  it('для untracked — зелёное название без точки', async () => {
    const container = await render({ id: 'n3', label: 'c.ts', vcsStatus: 'untracked' })
    expect(container.querySelector('[data-vcs-dot]')).toBeNull()
    const label = labelOf(container, 'c.ts')
    expect(label.className).toContain('text-status-success')
    expect(label.className).not.toContain('text-muted-foreground')
  })

  it('для ignored — приглушённое название без точки', async () => {
    const container = await render({ id: 'n3i', label: 'node_modules', vcsStatus: 'ignored' })
    expect(container.querySelector('[data-vcs-dot]')).toBeNull()
    expect(labelOf(container, 'node_modules').className).toContain('text-muted-foreground/50')
  })

  it('для deleted — красное зачёркнутое название и точка', async () => {
    const container = await render({ id: 'n3d', label: 'gone.ts', vcsStatus: 'deleted' })
    expect(container.querySelector('[data-vcs-dot="deleted"]')).not.toBeNull()
    const label = labelOf(container, 'gone.ts')
    expect(label.className).toContain('text-status-error')
    expect(label.className).toContain('line-through')
  })

  it('без vcsStatus точки нет', async () => {
    const container = await render({ id: 'n4', label: 'd.ts' })
    expect(container.querySelector('[data-vcs-dot]')).toBeNull()
  })

  it('иконка активного файла остаётся primary (поведение не ломается)', async () => {
    const container = await render({
      id: 'n5',
      label: 'e.ts',
      icon: 'file-text',
      isActive: true,
      vcsStatus: 'modified',
    })
    // Первый `svg` в строке — шеврон раскрытия; иконку файла ищем по классу.
    const icon = [...container.querySelectorAll('svg')].find((s) =>
      (s.getAttribute('class') ?? '').includes('shrink-0'),
    )
    expect(icon).not.toBeNull()
    expect(icon!.getAttribute('class') ?? '').toContain('text-primary')
  })
})
