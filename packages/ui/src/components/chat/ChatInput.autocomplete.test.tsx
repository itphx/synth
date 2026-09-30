import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

const mocks = vi.hoisted(() => ({
  getCommands: vi.fn(),
  onSend: vi.fn(),
  onStop: vi.fn(),
  onCreateNote: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({ synthApi: { getCommands: mocks.getCommands } }))
vi.mock('@/hooks/useDevice', () => ({ useDevice: () => ({ isTouch: false, deviceType: 'desktop' }) }))
vi.mock('../ui/OverlayScrollbar', () => ({ OverlayScrollbar: () => null }))
vi.mock('./ModelSelector', () => ({ ModelSelector: () => null }))
vi.mock('./AgentModeSelector', () => ({ AgentModeSelector: () => null }))
vi.mock('./PlanActModeToggle', () => ({ PlanActModeToggle: () => null }))
vi.mock('./ReasoningLevelSelector', () => ({ ReasoningLevelSelector: () => null }))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { ChatInput, splitMessageWithTags } from './ChatInput'
import type { AgentInfo } from '@/lib/api/synthApi'
import { useChatStore } from '@/stores/chatStore'
import { useSkillsStore } from '@/stores/skillsStore'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

async function renderInput(): Promise<HTMLElement> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <ChatInput
          sessionId="s1"
          agents={[]}
          isStreaming={false}
          onSend={mocks.onSend}
          onStop={mocks.onStop}
          onCreateNote={mocks.onCreateNote}
        />
      </I18nProvider>,
    )
  })
  await act(async () => {})
  return container
}

function setTextareaValue(el: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  setter.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getCommands.mockResolvedValue({
    commands: [{ name: 'help', kind: 'builtin', description: 'Show help', available: true }],
    diagnostics: [],
  })
  useChatStore.setState({ retryInputBySession: {} })
  useSkillsStore.setState({ commands: null, commandsLoading: false, commandsError: null })
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

describe('ChatInput — `/`-автокомплит (AD-046 §9.3)', () => {
  it('открывается на `/`, а выбор подставляет `/name ` без отправки', async () => {
    const container = await renderInput()
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement

    await act(async () => {
      setTextareaValue(textarea, '/he')
    })
    await act(async () => {})

    expect(container.querySelector('[data-testid="command-autocomplete"]')).not.toBeNull()
    const item = container.querySelector('[data-testid="command-autocomplete-item-help"]') as HTMLButtonElement
    expect(item).not.toBeNull()

    await act(async () => {
      item.click()
    })

    expect(textarea.value).toBe('/help ')
    expect(container.querySelector('[data-testid="command-autocomplete"]')).toBeNull()
    expect(mocks.onSend).not.toHaveBeenCalled()
  })

  it('Enter при открытом непустом списке не отправляет сообщение', async () => {
    const container = await renderInput()
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement

    await act(async () => {
      setTextareaValue(textarea, '/he')
    })
    await act(async () => {})

    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(mocks.onSend).not.toHaveBeenCalled()
  })

  it('после подстановки обычный Enter отправляет команду в core', async () => {
    const container = await renderInput()
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement

    await act(async () => {
      setTextareaValue(textarea, '/he')
    })
    await act(async () => {})
    await act(async () => {
      (container.querySelector('[data-testid="command-autocomplete-item-help"]') as HTMLButtonElement).click()
    })

    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })

    expect(mocks.onSend).toHaveBeenCalledWith('/help')
  })

  it('поповер имеет фиксированный зазор над рамкой композера (не зависит от высоты textarea)', async () => {
    const container = await renderInput()
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement

    await act(async () => {
      setTextareaValue(textarea, '/he')
    })
    await act(async () => {})

    const popup = container.querySelector('[data-testid="command-autocomplete"]') as HTMLElement
    expect(popup).not.toBeNull()
    // CSS-позиционирование от якоря: 9px до рамки композера + 8px зазора.
    expect(popup.style.bottom).toBe('calc(100% + 17px)')
  })
})

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

describe('ChatInput — splitMessageWithTags: `@`-тег сохраняется в тексте', () => {
  const agents = [makeAgent('pm'), makeAgent('dev')]

  it('одиночный тег: `@pm` остаётся в тексте части', () => {
    expect(splitMessageWithTags('@pm сделай X', agents)).toEqual([
      { text: '@pm сделай X', agentRole: 'pm' },
    ])
  })

  it('группа подряд идущих тегов: каждый текст содержит свой тег', () => {
    expect(splitMessageWithTags('@pm @dev сделай X', agents)).toEqual([
      { text: '@pm сделай X', agentRole: 'pm' },
      { text: '@dev сделай X', agentRole: 'dev' },
    ])
  })

  it('текст до первого тега (commonPrefix) сохраняется вместе с тегом', () => {
    expect(splitMessageWithTags('привет @pm сделай X', agents)).toEqual([
      { text: 'привет @pm сделай X', agentRole: 'pm' },
    ])
  })

  it('неизвестный тег не распознаётся — возврат null (сообщение уходит как есть)', () => {
    expect(splitMessageWithTags('@nobody сделай X', agents)).toBeNull()
  })
})
