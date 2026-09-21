import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

import { TitleTooltipBridge } from './TitleTooltipBridge'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ATTR = 'data-title-tip'
const DELAY_MS = 600

const mounted: Array<{ host: HTMLElement; root: Root }> = []

let rafSeq = 0
let rafQueue = new Map<number, FrameRequestCallback>()

// Детерминированно прогоняем отложенные rAF-колбэки внутри act.
function flushRaf() {
  const callbacks = Array.from(rafQueue.values())
  rafQueue.clear()
  return act(async () => {
    for (const cb of callbacks) cb(0)
  })
}

async function mount(child?: React.ReactNode): Promise<HTMLElement> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  mounted.push({ host, root })
  await act(async () => {
    root.render(
      <>
        {child}
        <TitleTooltipBridge />
      </>,
    )
  })
  return host
}

const hover = (el: Element) => el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
const unhover = (el: Element, relatedTarget: Element | null = null) =>
  el.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget }))

const tip = (): HTMLElement | null => document.querySelector('[role="tooltip"]')

async function showAfterDelay() {
  await act(async () => {
    vi.advanceTimersByTime(DELAY_MS)
  })
  await flushRaf()
  await flushRaf()
}

beforeEach(() => {
  vi.useFakeTimers()
  rafSeq = 0
  rafQueue = new Map()
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    const id = ++rafSeq
    rafQueue.set(id, cb)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    rafQueue.delete(id)
  })
})

afterEach(async () => {
  while (mounted.length > 0) {
    const entry = mounted.pop()!
    await act(async () => {
      entry.root.unmount()
    })
    entry.host.remove()
  }
  document.body.innerHTML = ''
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('TitleTooltipBridge', () => {
  it('показывает тултип после DELAY_MS и скрывает на mouseout', async () => {
    const host = await mount(<button title="Подсказка">btn</button>)
    const btn = host.querySelector('button')!

    await act(async () => {
      hover(btn)
    })
    // title сразу переносится в служебный атрибут, тултип ещё не показан
    expect(btn.hasAttribute('title')).toBe(false)
    expect(btn.getAttribute(ATTR)).toBe('Подсказка')
    expect(tip()).toBeNull()

    await act(async () => {
      vi.advanceTimersByTime(DELAY_MS)
    })
    // setTimeout сработал, но позиция считается в rAF — кадр ещё не прошёл
    expect(tip()).toBeNull()

    await flushRaf() // show(): getBoundingClientRect после кадра
    await flushRaf() // Tooltip: измерение размеров после кадра
    const el = tip()
    expect(el).not.toBeNull()
    expect(el!.textContent).toBe('Подсказка')
    expect(el!.style.visibility).toBe('visible')

    await act(async () => {
      unhover(btn)
    })
    expect(tip()).toBeNull()
    expect(btn.getAttribute('title')).toBe('Подсказка')
    expect(btn.hasAttribute(ATTR)).toBe(false)
  })

  it('подавляет title предков и восстанавливает их после скрытия', async () => {
    const host = await mount(
      <div title="родитель">
        <button title="дочерний">btn</button>
      </div>,
    )
    const parent = host.querySelector('div')!
    const btn = host.querySelector('button')!

    await act(async () => {
      hover(btn)
    })
    expect(parent.getAttribute('title')).toBeNull()

    await showAfterDelay()
    expect(tip()?.textContent).toBe('дочерний')

    await act(async () => {
      unhover(btn)
    })
    expect(parent.getAttribute('title')).toBe('родитель')
  })

  it('скрывает показанный тултип на scroll и mousedown', async () => {
    const host = await mount(<button title="Подсказка">btn</button>)
    const btn = host.querySelector('button')!

    await act(async () => {
      hover(btn)
    })
    await showAfterDelay()
    expect(tip()).not.toBeNull()

    await act(async () => {
      window.dispatchEvent(new Event('scroll'))
    })
    expect(tip()).toBeNull()
    expect(btn.getAttribute('title')).toBe('Подсказка')

    await act(async () => {
      hover(btn)
    })
    await showAfterDelay()
    expect(tip()).not.toBeNull()

    await act(async () => {
      btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })
    expect(tip()).toBeNull()
  })

  it('быстрый hover между элементами не оставляет висячих таймеров', async () => {
    const host = await mount(
      <div>
        <button id="a" title="A">
          A
        </button>
        <button id="b" title="B">
          B
        </button>
      </div>,
    )
    const a = host.querySelector('#a')!
    const b = host.querySelector('#b')!

    await act(async () => {
      hover(a)
    })
    await act(async () => {
      vi.advanceTimersByTime(300) // A ещё не показан
    })
    await act(async () => {
      hover(b) // перескок на B до срабатывания таймера A
    })
    await showAfterDelay()

    expect(tip()?.textContent).toBe('B')
    expect(a.getAttribute('title')).toBe('A')
    expect(a.hasAttribute(ATTR)).toBe(false)
  })

  it('не реагирует на hover при coarse pointer (тач)', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(pointer: coarse)',
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }))

    const host = await mount(<button title="Подсказка">btn</button>)
    const btn = host.querySelector('button')!

    await act(async () => {
      hover(btn)
    })
    await act(async () => {
      vi.advanceTimersByTime(1000)
    })
    await flushRaf()

    expect(tip()).toBeNull()
    expect(btn.getAttribute('title')).toBe('Подсказка')
    expect(btn.hasAttribute(ATTR)).toBe(false)
  })

  it('при unmount очищает таймеры и слушатели', async () => {
    const host = await mount(<button title="Подсказка">btn</button>)
    const btn = host.querySelector('button')!

    await act(async () => {
      hover(btn)
    })
    const entry = mounted.pop()!
    await act(async () => {
      entry.root.unmount()
    })
    entry.host.remove()

    await act(async () => {
      vi.advanceTimersByTime(1000)
    })
    await flushRaf()
    expect(tip()).toBeNull()
  })
})
