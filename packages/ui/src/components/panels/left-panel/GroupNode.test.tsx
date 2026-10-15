import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

import { I18nProvider, useI18n, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import type { TreeNodeBase } from '@/components/tree'
import { GroupNode } from './GroupNode'
import { MAX_VISIBLE_SESSIONS } from './constants'

/**
 * `left-panel/GroupNode.tsx` (ADR-095) — узел-группа дерева проектов: фильтрует
 * саб-агентов из корня, ограничивает видимое число сессий и деградирует
 * offline-remote проект. Тесты изолированные: без сети и реальных сторов.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

type Session = { id: string; name?: string; session_origin?: string; parent_id?: string }

interface HostProps {
  id?: string
  label?: string
  sessions: Session[]
  childrenByParentId?: Record<string, Session[]>
  expandedGroups?: Set<string>
  collapsed?: boolean
  toggleGroupExpand?: (k: string) => void
  expandedSessions?: Set<string>
  toggleSessionExpand?: (id: string) => void
  projectId?: string | null
  onCreateSession?: () => void
  onDropSession?: (sid: string) => void
  origin?: 'local' | 'remote'
  offline?: boolean
  isTouch?: boolean
  renderSessionNode?: (session: Session, depth: number, hasChildren: boolean, isExpanded: boolean, onToggle: () => void) => TreeNodeBase
}

/** Мост к реальным i18n-строкам (GroupNode принимает `t` пропом). */
function Host({
  id = 'p1',
  label = 'Proj',
  sessions,
  childrenByParentId = {},
  expandedGroups = new Set<string>(),
  collapsed = false,
  toggleGroupExpand = () => {},
  expandedSessions = new Set<string>(),
  toggleSessionExpand = () => {},
  projectId = 'p1',
  onCreateSession = () => {},
  onDropSession = () => {},
  origin,
  offline,
  isTouch,
  renderSessionNode,
}: HostProps) {
  const { t } = useI18n()
  return (
    <GroupNode
      id={id}
      label={label}
      icon="folder-3"
      isCollapsed={collapsed}
      onToggle={() => {}}
      sessions={sessions}
      childrenByParentId={childrenByParentId}
      expandedGroups={expandedGroups}
      toggleGroupExpand={toggleGroupExpand}
      renderSessionNode={
        renderSessionNode ?? ((s: Session, depth: number) => ({ id: `session:${s.id}`, label: s.name ?? s.id, depth, icon: 'chat-new' }))
      }
      expandedSessions={expandedSessions}
      toggleSessionExpand={toggleSessionExpand}
      projectId={projectId}
      onCreateSession={onCreateSession}
      onDropSession={onDropSession}
      origin={origin}
      offline={offline}
      isTouch={isTouch}
      t={t}
    />
  )
}

async function mount(props: HostProps): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <Host {...props} />
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

describe('GroupNode — состав и количество сессий', () => {
  it('в корне группы фильтруются сессии-саб-агенты (session_origin=subagent)', async () => {
    const sessions: Session[] = [
      { id: 's1', name: 'One' },
      { id: 's2', name: 'Two', session_origin: 'subagent', parent_id: 's1' },
      { id: 's3', name: 'Three' },
    ]
    const container = await mount({ sessions, childrenByParentId: { s1: [sessions[1]!] } })

    expect(sessionIds(container)).toEqual(['session:s1', 'session:s3'])
    expect(sessionIds(container)).not.toContain('session:s2')
  })

  it('счётчик группы показывает общее число сессий (включая саб-агентов)', async () => {
    const sessions: Session[] = [
      { id: 's1', name: 'One' },
      { id: 's2', name: 'Two', session_origin: 'subagent', parent_id: 's1' },
    ]
    const container = await mount({ sessions })

    const group = container.querySelector('[data-tree-node="group:p1"]')!
    expect(group.textContent).toContain('Proj')
    expect(group.textContent).toContain('2')
  })

  it('renderSessionNode получает hasChildren для сессии с саб-агентами', async () => {
    const render = vi.fn((s: Session, depth: number) => ({ id: `session:${s.id}`, label: s.name ?? s.id, depth }))
    const child: Session = { id: 's2', session_origin: 'subagent', parent_id: 's1' }
    await mount({ sessions: [{ id: 's1', name: 'One' }], childrenByParentId: { s1: [child] }, renderSessionNode: render })

    expect(render).toHaveBeenCalledWith(
      expect.objectContaining({ id: 's1' }),
      1,
      true,
      false,
      expect.any(Function),
    )
  })
})

describe('GroupNode — пагинация видимых сессий (MAX_VISIBLE_SESSIONS)', () => {
  const seven: Session[] = Array.from({ length: 7 }, (_, i) => ({ id: `s${i + 1}`, name: `S${i + 1}` }))

  it('свёрнутая группа показывает первые MAX_VISIBLE_SESSIONS и «Show N more»', async () => {
    const container = await mount({ sessions: seven })

    expect(sessionIds(container)).toHaveLength(MAX_VISIBLE_SESSIONS)
    const showMore = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Show 2 more'))
    expect(showMore).toBeTruthy()
  })

  it('кнопка «Show N more» раскрывает группу через toggleGroupExpand(project:<id>)', async () => {
    const toggleGroupExpand = vi.fn()
    const container = await mount({ sessions: seven, toggleGroupExpand })

    const showMore = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Show 2 more'))!
    await act(async () => {
      showMore.click()
    })

    expect(toggleGroupExpand).toHaveBeenCalledWith('project:p1')
  })

  it('раскрытая группа показывает все корневые сессии и «Show fewer»', async () => {
    const toggleGroupExpand = vi.fn()
    const container = await mount({
      sessions: seven,
      expandedGroups: new Set(['project:p1']),
      toggleGroupExpand,
    })

    expect(sessionIds(container)).toHaveLength(7)
    const showFewer = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Show fewer'))!
    expect(showFewer).toBeTruthy()
    await act(async () => {
      showFewer.click()
    })
    expect(toggleGroupExpand).toHaveBeenCalledWith('project:p1')
  })

  it('расширение группы «Без проекта» использует ключ group:__none__', async () => {
    const toggleGroupExpand = vi.fn()
    const container = await mount({
      id: '__none__',
      projectId: null,
      sessions: seven,
      expandedGroups: new Set(['group:__none__']),
      toggleGroupExpand,
    })

    expect(sessionIds(container)).toHaveLength(7)
    const showFewer = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Show fewer'))!
    await act(async () => {
      showFewer.click()
    })
    expect(toggleGroupExpand).toHaveBeenCalledWith('group:__none__')
  })
})

describe('GroupNode — offline-деградация remote-проекта', () => {
  it('offline + origin=remote → opacity-60 и тултип «unavailable»', async () => {
    const container = await mount({ sessions: [{ id: 's1' }], origin: 'remote', offline: true })

    const group = container.querySelector('[data-tree-node="group:p1"]')!
    expect(group.className).toContain('opacity-60')
    expect(group.getAttribute('title')).toBe(enDict['hybrid.unavailableNode'])
  })

  it('online remote-проект не приглушается', async () => {
    const container = await mount({ sessions: [{ id: 's1' }], origin: 'remote', offline: false })

    const group = container.querySelector('[data-tree-node="group:p1"]')!
    expect(group.className).not.toContain('opacity-60')
    expect(group.getAttribute('title')).toBeNull()
  })

  it('local-проект не приглушается даже при offline', async () => {
    const container = await mount({ sessions: [{ id: 's1' }], origin: 'local', offline: true })

    const group = container.querySelector('[data-tree-node="group:p1"]')!
    expect(group.className).not.toContain('opacity-60')
  })
})
