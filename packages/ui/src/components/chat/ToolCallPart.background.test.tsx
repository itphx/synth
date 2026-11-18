import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

const mocks = vi.hoisted(() => ({ moveSessionToBackground: vi.fn() }))

vi.mock('@/lib/backgroundDetach', () => ({
  moveSessionToBackground: mocks.moveSessionToBackground,
}))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { ToolCallPart } from './ToolCallPart'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

/** Снимок вызова `execute_shell` (по умолчанию running). */
function shellCall(overrides: Record<string, unknown> = {}) {
  return {
    name: 'execute_shell',
    args: { command: 'npm test' },
    callId: 'call-1',
    status: 'running' as const,
    ...overrides,
  }
}

async function render(toolCall: ReturnType<typeof shellCall>, sessionId?: string): Promise<HTMLElement> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <ToolCallPart toolCall={toolCall} sessionId={sessionId} />
      </I18nProvider>,
    )
  })
  await act(async () => {})
  return container
}

beforeEach(() => {
  mocks.moveSessionToBackground.mockReset()
  mocks.moveSessionToBackground.mockResolvedValue({ sessionId: 's1', detached: [{ id: 'blk_1', kind: 'process' }] })
})

afterEach(async () => {
  while (roots.length > 0) {
    const { root, container } = roots.pop()!
    await act(async () => root.unmount())
    container.remove()
  }
})

describe('ToolCallPart: «В фон» для running execute_shell (ADR-111 §detach)', () => {
  it('кнопка есть у running execute_shell и переводит вызов с type=process', async () => {
    const container = await render(shellCall(), 's1')
    const button = container.querySelector('[data-testid="tool-call-background"]') as HTMLElement | null
    expect(button).not.toBeNull()

    await act(async () => {
      button!.click()
    })
    await act(async () => {})

    expect(mocks.moveSessionToBackground).toHaveBeenCalledTimes(1)
    expect(mocks.moveSessionToBackground).toHaveBeenCalledWith('s1', {
      type: 'process',
      callIds: ['call-1'],
    })
  })

  it('после успешного перевода кнопка больше не показывается', async () => {
    const container = await render(shellCall(), 's1')
    const button = container.querySelector('[data-testid="tool-call-background"]') as HTMLElement
    await act(async () => {
      button.click()
    })
    await act(async () => {})

    expect(container.querySelector('[data-testid="tool-call-background"]')).toBeNull()
  })

  it('нет кнопки у завершённого вызова, другого тула и без sessionId', async () => {
    const done = await render(shellCall({ status: 'done', result: { content: 'ok' } }), 's1')
    expect(done.querySelector('[data-testid="tool-call-background"]')).toBeNull()

    const other = await render(shellCall({ name: 'read_file' }), 's1')
    expect(other.querySelector('[data-testid="tool-call-background"]')).toBeNull()

    const noSession = await render(shellCall(), undefined)
    expect(noSession.querySelector('[data-testid="tool-call-background"]')).toBeNull()
  })
})
