import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

import { useBackClose, __resetBackCloseForTests } from './useBackClose'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

function Probe({ open, onClose }: { open: boolean; onClose: () => void }) {
  useBackClose(open, onClose)
  return null
}

async function mount(element: React.ReactElement): Promise<{ root: Root; container: HTMLElement }> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(element)
  })
  return { root, container }
}

function overlayId(): unknown {
  return (window.history.state as Record<string, unknown> | null)?.synthBackOverlay
}

function dispatchPopState(): void {
  window.dispatchEvent(new PopStateEvent('popstate'))
}

let backSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  __resetBackCloseForTests()
  window.history.replaceState({}, '')
  backSpy = vi.spyOn(window.history, 'back').mockImplementation(() => {})
})

afterEach(async () => {
  while (roots.length > 0) {
    const { root, container } = roots.pop()!
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
  document.body.innerHTML = ''
  __resetBackCloseForTests()
  window.history.replaceState({}, '')
  backSpy.mockRestore()
})

describe('useBackClose: кнопка «назад» закрывает верхний оверлей', () => {
  it('открытие кладёт запись в историю', async () => {
    await mount(<Probe open onClose={() => {}} />)
    expect(overlayId()).toEqual(expect.any(Number))
  })

  it('popstate закрывает оверлей', async () => {
    const onClose = vi.fn()
    await mount(<Probe open onClose={onClose} />)

    await act(async () => {
      dispatchPopState()
    })

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('disposer после popstate не делает лишний history.back', async () => {
    const onClose = vi.fn()
    const { root } = await mount(<Probe open onClose={onClose} />)

    await act(async () => {
      dispatchPopState()
    })
    await act(async () => {
      root.render(<Probe open={false} onClose={onClose} />)
    })

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(backSpy).not.toHaveBeenCalled()
  })

  it('программное закрытие: history.back один раз, следующий popstate подавлен', async () => {
    const onClose = vi.fn()
    const { root } = await mount(<Probe open onClose={onClose} />)

    await act(async () => {
      root.render(<Probe open={false} onClose={onClose} />)
    })

    expect(backSpy).toHaveBeenCalledTimes(1)
    expect(onClose).not.toHaveBeenCalled()

    // «Своё» popstate от history.back() не должно закрывать оверлей под ним.
    await act(async () => {
      dispatchPopState()
    })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('вложенные записи: back закрывает верхнюю, затем нижнюю', async () => {
    const closeLower = vi.fn()
    const closeUpper = vi.fn()
    await mount(
      <>
        <Probe open onClose={closeLower} />
        <Probe open onClose={closeUpper} />
      </>,
    )
    expect(overlayId()).toEqual(expect.any(Number))

    await act(async () => {
      dispatchPopState()
    })
    expect(closeUpper).toHaveBeenCalledTimes(1)
    expect(closeLower).not.toHaveBeenCalled()

    await act(async () => {
      dispatchPopState()
    })
    expect(closeLower).toHaveBeenCalledTimes(1)
  })

  it('закрытый оверлей не оставляет popstate в стеке', async () => {
    const onClose = vi.fn()
    await mount(<Probe open={false} onClose={onClose} />)

    await act(async () => {
      dispatchPopState()
    })

    expect(onClose).not.toHaveBeenCalled()
    expect(backSpy).not.toHaveBeenCalled()
  })
})
