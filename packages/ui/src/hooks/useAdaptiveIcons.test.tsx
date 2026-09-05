import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React, { useRef } from 'react'

import { useAdaptiveIcons } from './useAdaptiveIcons'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Ширина скрытой панели (см. MIN_CONTAINER_WIDTH_PX в хуке).
const MIN_WIDTH_PX = 64

type Layout = { width: number; labelClient: number; labelScroll: number }

// Подписи «режутся» (scrollWidth > clientWidth) — как при узкой панели.
const overflowLayout = (width: number): Layout => ({ width, labelClient: 50, labelScroll: 120 })
// Подписи влезают целиком.
const fitsLayout = (width: number): Layout => ({ width, labelClient: 200, labelScroll: 100 })

class MockResizeObserver {
  static last: MockResizeObserver | null = null
  callback: () => void
  constructor(callback: () => void) {
    this.callback = callback
    MockResizeObserver.last = this
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}

function triggerResize(): void {
  MockResizeObserver.last?.callback()
}

function applyLayout(probe: HTMLElement, layout: Layout): void {
  Object.defineProperty(probe, 'clientWidth', { configurable: true, get: () => layout.width })
  for (const label of Array.from(probe.querySelectorAll<HTMLElement>('[data-tab-label]'))) {
    Object.defineProperty(label, 'clientWidth', { configurable: true, get: () => layout.labelClient })
    Object.defineProperty(label, 'scrollWidth', { configurable: true, get: () => layout.labelScroll })
  }
}

// Повторяет разметку панелей: подписи рендерятся только при !iconsOnly.
function Probe() {
  const ref = useRef<HTMLDivElement>(null)
  const iconsOnly = useAdaptiveIcons(ref)
  return (
    <div data-probe ref={ref}>
      {!iconsOnly && ['Проекты', 'Файлы', 'Git'].map((label) => (
        <span key={label} data-tab-label className="truncate">{label}</span>
      ))}
      <output data-icons-only={String(iconsOnly)} />
    </div>
  )
}

type Mounted = { host: HTMLElement; root: Root }

const mounted: Mounted[] = []

async function mountProbe(): Promise<HTMLElement> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  mounted.push({ host, root })
  await act(async () => {
    root.render(<Probe />)
  })
  return host.querySelector<HTMLElement>('[data-probe]')!
}

const iconsOnlyState = (probe: HTMLElement): boolean =>
  probe.querySelector('[data-icons-only]')?.getAttribute('data-icons-only') === 'true'

beforeEach(() => {
  MockResizeObserver.last = null
  vi.stubGlobal('ResizeObserver', MockResizeObserver)
  vi.useFakeTimers()
})

afterEach(async () => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  while (mounted.length > 0) {
    const { root, host } = mounted.pop()!
    await act(async () => {
      root.unmount()
    })
    host.remove()
  }
})

describe('useAdaptiveIcons', () => {
  it('не осциллирует: после включения iconsOnly последующие события с той же шириной не возвращают текст', async () => {
    const probe = await mountProbe()

    // Открытие на узкую ширину: обрезка с первого замера, textFitsWidthRef не измерен.
    applyLayout(probe, overflowLayout(150))
    await act(async () => {
      triggerResize()
    })
    expect(iconsOnlyState(probe)).toBe(false)
    await act(async () => {
      vi.advanceTimersByTime(300)
    })
    expect(iconsOnlyState(probe)).toBe(true)

    // Последующие события (кадры анимации/ресайзы) ниже порога возврата (150+32).
    for (const width of [150, 160, 170]) {
      applyLayout(probe, overflowLayout(width))
      await act(async () => {
        triggerResize()
      })
      expect(iconsOnlyState(probe)).toBe(true)
    }
    await act(async () => {
      vi.advanceTimersByTime(1000)
    })
    expect(iconsOnlyState(probe)).toBe(true)
  })

  it('стабильно остаётся iconsOnly при серии resize во время открытия панели', async () => {
    const probe = await mountProbe()

    // Анимация открытия: ширина растёт от <64 до рабочей (обрезка всю дорогу).
    applyLayout(probe, overflowLayout(MIN_WIDTH_PX - 20))
    await act(async () => {
      triggerResize()
    })
    applyLayout(probe, overflowLayout(80))
    await act(async () => {
      triggerResize()
    })
    applyLayout(probe, overflowLayout(110))
    await act(async () => {
      triggerResize()
    })
    applyLayout(probe, overflowLayout(150))
    await act(async () => {
      triggerResize()
    })
    await act(async () => {
      vi.advanceTimersByTime(300)
    })
    expect(iconsOnlyState(probe)).toBe(true)

    // Анимация ещё идёт — ширина колеблется, но не превышает порог возврата.
    for (const width of [160, 140, 170, 180]) {
      applyLayout(probe, overflowLayout(width))
      await act(async () => {
        triggerResize()
      })
      expect(iconsOnlyState(probe)).toBe(true)
    }
    await act(async () => {
      vi.advanceTimersByTime(1000)
    })
    expect(iconsOnlyState(probe)).toBe(true)
  })

  it('возвращает текст при расширении выше порога, но только после debounce', async () => {
    const probe = await mountProbe()

    applyLayout(probe, overflowLayout(150))
    await act(async () => {
      triggerResize()
    })
    await act(async () => {
      vi.advanceTimersByTime(300)
    })
    expect(iconsOnlyState(probe)).toBe(true)

    // Панель расширена: текст уже влезает. Возврат не мгновенный.
    applyLayout(probe, fitsLayout(200))
    await act(async () => {
      triggerResize()
    })
    expect(iconsOnlyState(probe)).toBe(true)
    await act(async () => {
      vi.advanceTimersByTime(299)
    })
    expect(iconsOnlyState(probe)).toBe(true)
    await act(async () => {
      vi.advanceTimersByTime(1)
    })
    expect(iconsOnlyState(probe)).toBe(false)

    // Подписи снова видны и влезают — текст остаётся.
    applyLayout(probe, fitsLayout(200))
    await act(async () => {
      triggerResize()
    })
    await act(async () => {
      vi.advanceTimersByTime(1000)
    })
    expect(iconsOnlyState(probe)).toBe(false)
  })

  it('не возвращает текст, если расширение меньше гистерезисной маржи', async () => {
    const probe = await mountProbe()

    applyLayout(probe, overflowLayout(150))
    await act(async () => {
      triggerResize()
    })
    await act(async () => {
      vi.advanceTimersByTime(300)
    })
    expect(iconsOnlyState(probe)).toBe(true)

    // 180 < 150 + 32 — всё ещё иконки.
    applyLayout(probe, overflowLayout(180))
    await act(async () => {
      triggerResize()
    })
    await act(async () => {
      vi.advanceTimersByTime(1000)
    })
    expect(iconsOnlyState(probe)).toBe(true)
  })

  it('не включает iconsOnly, когда ширина с самого начала достаточна', async () => {
    const probe = await mountProbe()

    applyLayout(probe, fitsLayout(400))
    await act(async () => {
      triggerResize()
    })
    await act(async () => {
      vi.advanceTimersByTime(1000)
    })
    expect(iconsOnlyState(probe)).toBe(false)
  })

  it('не включает iconsOnly на закрытой панели (ширина < порога) и отменяет таймер', async () => {
    const probe = await mountProbe()

    applyLayout(probe, overflowLayout(100))
    await act(async () => {
      triggerResize()
    })
    // Панель закрылась до срабатывания debounce.
    applyLayout(probe, overflowLayout(40))
    await act(async () => {
      triggerResize()
    })
    await act(async () => {
      vi.advanceTimersByTime(1000)
    })
    expect(iconsOnlyState(probe)).toBe(false)
  })

  it('не осциллирует, когда текст не влезает даже после «возврата»: якорь двигается вверх', async () => {
    const probe = await mountProbe()

    applyLayout(probe, overflowLayout(150))
    await act(async () => {
      triggerResize()
    })
    await act(async () => {
      vi.advanceTimersByTime(300)
    })
    expect(iconsOnlyState(probe)).toBe(true)

    // Расширение до 200 (> 150+32), но текст по-прежнему режется на 200.
    applyLayout(probe, overflowLayout(200))
    await act(async () => {
      triggerResize()
    })
    await act(async () => {
      vi.advanceTimersByTime(300)
    })
    expect(iconsOnlyState(probe)).toBe(false)

    // Снова обрезка → повторное включение на новой ширине (якорь 200, порог 232).
    applyLayout(probe, overflowLayout(200))
    await act(async () => {
      triggerResize()
    })
    await act(async () => {
      vi.advanceTimersByTime(300)
    })
    expect(iconsOnlyState(probe)).toBe(true)

    // Колебания до 232 не приводят к циклу текст↔иконки.
    for (const width of [205, 210, 220, 230]) {
      applyLayout(probe, overflowLayout(width))
      await act(async () => {
        triggerResize()
      })
      expect(iconsOnlyState(probe)).toBe(true)
    }
    await act(async () => {
      vi.advanceTimersByTime(1000)
    })
    expect(iconsOnlyState(probe)).toBe(true)
  })
})
