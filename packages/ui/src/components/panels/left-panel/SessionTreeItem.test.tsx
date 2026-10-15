import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { SessionTreeItem } from './SessionTreeItem'

/**
 * `left-panel/SessionTreeItem.tsx` (ADR-095) — рекурсивный рендер дерева сессий.
 * Ключевая логика: дочерние сессии рисуются только при `depth < 2` (ограничение
 * вложенности саб-агентов) и только для раскрытых узлов.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

type Session = { id: string; name?: string }

const renderSessionNode = vi.fn((s: Session, depth: number) => ({
  id: `session:${s.id}`,
  label: s.name ?? s.id,
  depth,
  hasChildren: true,
  isExpanded: true,
  onToggle: () => {},
}))

async function mount(opts: {
  session: Session
  depth: number
  childrenByParentId?: Record<string, Session[]>
  expandedSessions?: Set<string>
}): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <SessionTreeItem
          session={opts.session}
          depth={opts.depth}
          childrenByParentId={opts.childrenByParentId ?? {}}
          renderSessionNode={renderSessionNode}
          expandedSessions={opts.expandedSessions ?? new Set()}
          onToggleExpand={() => {}}
        />
      </I18nProvider>,
    )
  })
  return container
}

function sessionIds(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[data-tree-node^="session:"]')].map(
    (el) => el.getAttribute('data-tree-node')!,
  )
}

beforeEach(() => {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
})

afterEach(async () => {
  while (roots.length > 0) {
    const { root, container } = roots.pop()!
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
  vi.clearAllMocks()
})

describe('SessionTreeItem — рекурсия и ограничение глубины', () => {
  it('раскрытый узел рендерит дочерние сессии', async () => {
    const container = await mount({
      session: { id: 's1', name: 'One' },
      depth: 0,
      childrenByParentId: { s1: [{ id: 'c1', name: 'Child' }] },
      expandedSessions: new Set(['s1']),
    })

    expect(sessionIds(container)).toEqual(['session:s1', 'session:c1'])
  })

  it('свёрнутый узел не рендерит дочерние сессии', async () => {
    const container = await mount({
      session: { id: 's1', name: 'One' },
      depth: 0,
      childrenByParentId: { s1: [{ id: 'c1' }] },
      expandedSessions: new Set(),
    })

    expect(sessionIds(container)).toEqual(['session:s1'])
  })

  it('на depth=2 дочерние сессии не рисуются (ограничение вложенности)', async () => {
    const container = await mount({
      session: { id: 's1', name: 'One' },
      depth: 2,
      childrenByParentId: { s1: [{ id: 'c1' }] },
      expandedSessions: new Set(['s1']),
    })

    expect(sessionIds(container)).toEqual(['session:s1'])
  })

  it('глубина передаётся возрастающей в renderSessionNode', async () => {
    const container = await mount({
      session: { id: 's1', name: 'One' },
      depth: 0,
      childrenByParentId: { s1: [{ id: 'c1' }], c1: [{ id: 'g1' }] },
      expandedSessions: new Set(['s1', 'c1']),
    })

    expect(sessionIds(container)).toEqual(['session:s1', 'session:c1', 'session:g1'])
    expect(renderSessionNode).toHaveBeenCalledWith(expect.objectContaining({ id: 'g1' }), 2, expect.any(Boolean), expect.any(Boolean), expect.any(Function))
  })
})
