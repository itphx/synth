import { describe, it, expect, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

vi.mock('@/lib/api/synthApi', () => ({ synthApi: { auditRevealed: vi.fn() } }))

import { SecretPlainText, splitMentions } from './SecretPlaceholder'
import type { AgentInfo } from '@/lib/api/synthApi'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function makeAgent(id: string, color: string | null = null): AgentInfo {
  return {
    id,
    display_name: id,
    capabilities: [],
    enabled: true,
    icon: null,
    color,
    description: null,
    available: true,
    mode: 'simple',
    agent_mode: null,
    subagent_prompt: null,
    max_steps: null,
    provider: null,
    model: null,
    context_file: null,
    is_builtin: true,
    is_overridden: false,
  }
}

const AGENTS: AgentInfo[] = [makeAgent('pm', '--status-error'), makeAgent('dev', null)]

const roots: Array<{ root: Root; container: HTMLElement }> = []

async function renderPlain(content: string, agents: AgentInfo[] = AGENTS): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(<SecretPlainText content={content} agents={agents} />)
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

describe('SecretPlainText — подсветка `@`-упоминаний (сообщения пользователя)', () => {
  it('известное упоминание оборачивается в span с цветом агента', async () => {
    const container = await renderPlain('@pm сделай X')
    const mention = container.querySelector('[data-mention="pm"]') as HTMLElement | null
    expect(mention).not.toBeNull()
    expect(mention!.textContent).toBe('@pm')
    expect(mention!.style.color).toBe('var(--status-error)')
    // Полный текст сохранён — тег не вырезан.
    expect(container.querySelector('p')!.textContent).toBe('@pm сделай X')
  })

  it('несколько упоминаний: текст и переносы не теряются', async () => {
    const container = await renderPlain('@pm и @dev\nвторая строка')
    const mentions = container.querySelectorAll('[data-mention]')
    expect(mentions.length).toBe(2)
    expect(container.querySelector('p')!.textContent).toBe('@pm и @dev\nвторая строка')
  })

  it('неизвестный агент не подсвечивается и остаётся обычным текстом', async () => {
    const container = await renderPlain('@nobody привет')
    expect(container.querySelector('[data-mention]')).toBeNull()
    expect(container.querySelector('p')!.textContent).toBe('@nobody привет')
  })

  it('без агентов в реестре рендерится как раньше (plain text)', async () => {
    const container = await renderPlain('@pm сделай X', [])
    expect(container.querySelector('[data-mention]')).toBeNull()
    expect(container.querySelector('p')!.textContent).toBe('@pm сделай X')
  })
})

describe('splitMentions', () => {
  it('возвращает известные и неизвестные токены корректно', () => {
    expect(splitMentions('@x @pm привет', [makeAgent('pm')])).toEqual([
      { type: 'text', value: '@x ' },
      { type: 'mention', value: '@pm', agent: makeAgent('pm') },
      { type: 'text', value: ' привет' },
    ])
  })

  it('без совпадений — единственный текстовый сегмент', () => {
    expect(splitMentions('просто текст', [makeAgent('pm')])).toEqual([
      { type: 'text', value: 'просто текст' },
    ])
  })
})
