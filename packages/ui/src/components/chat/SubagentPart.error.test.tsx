import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

vi.mock('@/lib/api/synthApi', () => ({
  synthApi: {
    resumeSubagent: vi.fn().mockResolvedValue({ status: 'started' }),
    stopGeneration: vi.fn().mockResolvedValue(undefined),
  },
}))

// useUIStore использует zustand persist (localStorage в jsdom-среде тестов
// недоступен в момент импорта модуля) — подменяем лёгким стабом вкладок.
vi.mock('@/stores/useUIStore', () => {
  const state = {
    centerTabs: [{ id: 'chat-parent', type: 'chat', title: 'Родитель', data: { sessionId: 'parent' } }],
    activeCenterTabId: 'chat-parent',
  }
  const useUIStore = ((selector: (s: typeof state) => unknown) => selector(state)) as {
    (selector: (s: typeof state) => unknown): unknown
    getState: () => typeof state
    setState: (patch: Partial<typeof state>) => void
  }
  useUIStore.getState = () => state
  useUIStore.setState = (patch: Partial<typeof state>) => Object.assign(state, patch)
  return { useUIStore }
})

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as ruDict } from '@/lib/i18n/messages/ru'
import { SubagentPart, type SubagentPartData } from './SubagentPart'
import { useChatStore } from '@/stores/chatStore'
import { synthApi } from '@/lib/api/synthApi'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function makeSubagent(partial: Partial<SubagentPartData>): SubagentPartData {
  return {
    name: 'researcher',
    sessionId: 'child-1234',
    callId: 'call-1',
    ...partial,
  }
}

const roots: Array<{ root: Root; container: HTMLElement }> = []

async function renderSubagent(data: SubagentPartData, ownerSessionId: string): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <SubagentPart subagent={data} />
      </I18nProvider>,
    )
  })
  void ownerSessionId
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
  useChatStore.setState({ subagentRetryBySession: {}, subagentResumingBySession: {} })
})

describe('SubagentPart: плашка ошибки внизу блока (B7)', () => {
  beforeAll(() => {
    useI18nStore.setState({ locale: 'ru', dictionary: ruDict, loadingLocale: null })
  })

  it('isError + recoverable (server_error) → «Сабагент остановлен…» + кнопка «Продолжить»', async () => {
    const container = await renderSubagent(makeSubagent({
      errorInfo: { isError: true, attempts: 3, maxRetries: 3, errorType: 'server_error' },
    }), 'parent')
    expect(container.textContent).toContain('Сабагент остановлен: ошибка провайдера')
    expect(container.textContent).toContain('попыток: 3/3')
    const btn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Продолжить',
    )
    expect(btn).toBeDefined()
  })

  it('клик «Продолжить» вызывает resumeSubagent по child_session_id', async () => {
    const container = await renderSubagent(makeSubagent({
      errorInfo: { isError: true, attempts: 3, maxRetries: 3, errorType: 'rate_limit' },
    }), 'parent')
    const btn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Продолжить',
    )
    expect(btn).toBeDefined()
    await act(async () => {
      btn!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(synthApi.resumeSubagent).toHaveBeenCalledWith('child-1234')
  })

  it('context_length → плашка есть, кнопки «Продолжить» нет', async () => {
    const container = await renderSubagent(makeSubagent({
      errorInfo: { isError: true, attempts: 1, maxRetries: 3, errorType: 'context_length' },
    }), 'parent')
    expect(container.textContent).toContain('Сабагент остановлен: ошибка провайдера')
    const btn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Продолжить',
    )
    expect(btn).toBeUndefined()
  })

  it('без ошибки плашки нет', async () => {
    const container = await renderSubagent(makeSubagent({}), 'parent')
    expect(container.textContent).not.toContain('Сабагент остановлен')
    expect(container.textContent).not.toContain('Продолжить')
  })

  it('resume.started (child_session_id блока) → «Возобновление…» + «Остановить», без кнопки «Продолжить»', async () => {
    useChatStore.setState({
      subagentResumingBySession: {
        parent: { childSessionId: 'child-1234', parentSessionId: 'parent', streamId: 'st-r' },
      },
    })
    const container = await renderSubagent(makeSubagent({
      errorInfo: { isError: true, attempts: 3, maxRetries: 3, errorType: 'server_error' },
    }), 'parent')
    expect(container.textContent).toContain('Возобновление…')
    expect(container.textContent).toContain('Остановить')
    const resumeBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Продолжить',
    )
    expect(resumeBtn).toBeUndefined()
  })

  it('subagent.retry (тот же callId, live-блок) → «Повторная попытка 2/3»', async () => {
    useChatStore.setState({
      subagentRetryBySession: {
        parent: { callId: 'call-1', childSessionId: 'child-1234', attempt: 2, maxRetries: 3, retryInMs: 15000 },
      },
    })
    const container = await renderSubagent(makeSubagent({
      live: true,
    }), 'parent')
    expect(container.textContent).toContain('Повторная попытка 2/3')
  })

  it('subagent.retry другого callId не показывается в этом блоке', async () => {
    useChatStore.setState({
      subagentRetryBySession: {
        parent: { callId: 'call-other', attempt: 2, maxRetries: 3, retryInMs: 15000 },
      },
    })
    const container = await renderSubagent(makeSubagent({ live: true }), 'parent')
    expect(container.textContent).not.toContain('Повторная попытка')
  })

  it('retry-статус не показывается в историческом (не live) блоке', async () => {
    useChatStore.setState({
      subagentRetryBySession: {
        parent: { callId: 'call-1', attempt: 2, maxRetries: 3, retryInMs: 15000 },
      },
    })
    const container = await renderSubagent(makeSubagent({ live: false }), 'parent')
    expect(container.textContent).not.toContain('Повторная попытка')
  })
})
