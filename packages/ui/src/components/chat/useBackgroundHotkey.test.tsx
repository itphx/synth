import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

const mocks = vi.hoisted(() => ({
  moveSessionToBackground: vi.fn(),
}))

vi.mock('@/lib/backgroundDetach', () => ({
  moveSessionToBackground: mocks.moveSessionToBackground,
}))

import { useBackgroundHotkey } from './useBackgroundHotkey'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function Harness({ sessionId, enabled }: { sessionId: string; enabled: boolean }) {
  useBackgroundHotkey(sessionId, enabled)
  return (
    <div>
      <div data-testid="editor" contentEditable suppressContentEditableWarning />
    </div>
  )
}

const roots: Array<{ root: Root; container: HTMLElement }> = []

async function renderHarness(enabled = true, sessionId = 's1'): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(<Harness sessionId={sessionId} enabled={enabled} />)
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

beforeEach(() => {
  mocks.moveSessionToBackground.mockReset()
  mocks.moveSessionToBackground.mockResolvedValue({ sessionId: 's1', detached: [] })
})

/** keydown `ctrl+b` на указанной цели; true — событие отменено (preventDefault). */
async function pressCtrlB(target: EventTarget, init: KeyboardEventInit = {}): Promise<boolean> {
  const event = new KeyboardEvent('keydown', {
    key: 'b',
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
    ...init,
  })
  let notCanceled = true
  await act(async () => {
    notCanceled = target.dispatchEvent(event)
  })
  return !notCanceled
}

describe('useBackgroundHotkey — ctrl+b (ADR-111 §detach)', () => {
  it('ctrl+b при активном стриме → backgroundSession без type + preventDefault', async () => {
    await renderHarness(true, 's1')

    const prevented = await pressCtrlB(window)

    expect(prevented).toBe(true)
    expect(mocks.moveSessionToBackground).toHaveBeenCalledTimes(1)
    expect(mocks.moveSessionToBackground).toHaveBeenCalledWith('s1')
  })

  it('вне стрима (enabled=false) — запроса нет', async () => {
    await renderHarness(false, 's1')

    await pressCtrlB(window)

    expect(mocks.moveSessionToBackground).not.toHaveBeenCalled()
  })

  it('без sessionId — запроса нет', async () => {
    await renderHarness(true, '')

    await pressCtrlB(window)

    expect(mocks.moveSessionToBackground).not.toHaveBeenCalled()
  })

  it('e.repeat — запроса нет', async () => {
    await renderHarness(true)

    await pressCtrlB(window, { repeat: true })

    expect(mocks.moveSessionToBackground).not.toHaveBeenCalled()
  })

  it('isComposing (IME) — запроса нет', async () => {
    await renderHarness(true)

    await pressCtrlB(window, { isComposing: true })

    expect(mocks.moveSessionToBackground).not.toHaveBeenCalled()
  })

  it('фокус в contenteditable — запроса нет, событие не отменяем', async () => {
    const container = await renderHarness(true)
    const editor = container.querySelector('[data-testid="editor"]') as HTMLElement

    const prevented = await pressCtrlB(editor)

    expect(prevented).toBe(false)
    expect(mocks.moveSessionToBackground).not.toHaveBeenCalled()
  })

  it('другие клавиши и ctrl+shift+b не перехватываются', async () => {
    await renderHarness(true)

    await pressCtrlB(window, { key: 'i' })
    await pressCtrlB(window, { shiftKey: true })

    expect(mocks.moveSessionToBackground).not.toHaveBeenCalled()
  })

  it('повторное нажатие во время запроса не дублирует вызов', async () => {
    let resolveRequest: (value: unknown) => void = () => {}
    mocks.moveSessionToBackground.mockImplementation(() => new Promise((resolve) => {
      resolveRequest = resolve
    }))
    await renderHarness(true)

    await pressCtrlB(window)
    await pressCtrlB(window)
    expect(mocks.moveSessionToBackground).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveRequest({ sessionId: 's1', detached: [] })
    })

    await pressCtrlB(window)
    expect(mocks.moveSessionToBackground).toHaveBeenCalledTimes(2)
  })
})
