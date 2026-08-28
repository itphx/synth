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

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as ruDict } from '@/lib/i18n/messages/ru'
import { SubagentResumeBar, type SubagentSessionError } from './SubagentResumeBar'
import { useChatStore } from '@/stores/chatStore'
import { synthApi } from '@/lib/api/synthApi'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

async function renderBar(
  sessionId: string,
  lastError: SubagentSessionError | null,
  handlers: { onResume: () => void; onStop: () => void },
): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <SubagentResumeBar sessionId={sessionId} lastError={lastError} onResume={handlers.onResume} onStop={handlers.onStop} />
      </I18nProvider>,
    )
  })
  return container
}

function findBtn(container: HTMLElement, label: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === label,
  )
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

describe('SubagentResumeBar (B8: плашка в дочерней сессии над read-only заглушкой)', () => {
  beforeAll(() => {
    useI18nStore.setState({ locale: 'ru', dictionary: ruDict, loadingLocale: null })
  })

  it('ошибка recoverable → «Сабагент остановлен…» (попытки) + «Продолжить»', async () => {
    const container = await renderBar('child', {
      attempts: 3, maxRetries: 3, errorType: 'network',
    }, { onResume: () => {}, onStop: () => {} })
    expect(container.textContent).toContain('Сабагент остановлен: ошибка провайдера')
    expect(container.textContent).toContain('попыток: 3/3')
    expect(findBtn(container, 'Продолжить')).toBeDefined()
  })

  it('клик «Продолжить» вызывает resumeSubagent для сессии вкладки', async () => {
    let resumed = false
    const container = await renderBar('child', {
      attempts: 2, maxRetries: 3, errorType: 'timeout',
    }, { onResume: () => { resumed = true }, onStop: () => {} })
    const btn = findBtn(container, 'Продолжить')
    expect(btn).toBeDefined()
    await act(async () => {
      btn!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(resumed).toBe(true)
  })

  it('context_length → только текст, без «Продолжить»', async () => {
    const container = await renderBar('child', {
      attempts: 1, maxRetries: 3, errorType: 'context_length',
    }, { onResume: () => {}, onStop: () => {} })
    expect(findBtn(container, 'Продолжить')).toBeUndefined()
  })

  it('нет ошибки → не рендерится', async () => {
    const container = await renderBar('child', null, { onResume: () => {}, onStop: () => {} })
    expect(container.textContent).toBe('')
  })

  it('resume.started в дочерней сессии → «Возобновление…» + «Остановить» (abort по sessionId)', async () => {
    useChatStore.setState({
      subagentResumingBySession: {
        child: { childSessionId: 'child', parentSessionId: 'parent', streamId: 'st-r' },
      },
    })
    let stopped = false
    const container = await renderBar('child', {
      attempts: 3, maxRetries: 3, errorType: 'server_error',
    }, { onResume: () => {}, onStop: () => { stopped = true } })
    expect(container.textContent).toContain('Возобновление…')
    const stop = findBtn(container, 'Остановить')
    expect(stop).toBeDefined()
    await act(async () => {
      stop!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(stopped).toBe(true)
  })

  it('resume.finished → плашка ошибки возвращается', async () => {
    useChatStore.setState({ subagentResumingBySession: { child: null } })
    const container = await renderBar('child', {
      attempts: 3, maxRetries: 3, errorType: 'server_error',
    }, { onResume: () => {}, onStop: () => {} })
    expect(findBtn(container, 'Продолжить')).toBeDefined()
    expect(synthApi.stopGeneration).not.toHaveBeenCalled()
  })
})
