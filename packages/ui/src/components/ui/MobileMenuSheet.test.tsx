/**
 * Мобильная панель списка (общий компонент селекторов композера).
 *
 * Проверяется то, ради чего панель появилась: фиксированный лист в портале,
 * нижняя кромка прижата к верху композера (поле ввода не перекрыто), верх не
 * уходит за экран, содержимое скроллится внутри, позиция пересчитывается на
 * resize/visualViewport, закрытие — тап вне и Escape.
 *
 * Отдельный блок — стабилизация layout после скрытия экранной клавиатуры: при
 * наборе текста layout сжат (композер поднят), `blurActiveElement` запускает
 * скрытие клавиатуры, и панель не должна показываться в промежуточной позиции,
 * иначе через 200–300 мс она уезжает вниз под палец.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { MobileMenuSheet, measureSheetGeometry } from './MobileMenuSheet'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const VIEWPORT_HEIGHT = 800

const originalInnerHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight')
const roots: Array<{ root: Root; container: HTMLElement }> = []

/**
 * Искусственный `visualViewport`: jsdom его не реализует, а без него не
 * смоделировать открытую экранную клавиатуру. Объект ведёт себя как настоящий
 * API — `EventTarget` с изменяемой `height`.
 */
interface FakeVisualViewport extends EventTarget {
  height: number
}

function installVisualViewport(height: number): FakeVisualViewport {
  const viewport = Object.assign(new EventTarget(), { height }) as FakeVisualViewport
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport })
  return viewport
}

function clearVisualViewport(): void {
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: undefined })
}

/** jsdom не считает layout: прямоугольник задаётся точечно на элементе. */
function stubRect(element: HTMLElement, top: number, height = 120): void {
  element.getBoundingClientRect = () =>
    ({
      x: 0,
      y: top,
      top,
      left: 0,
      right: 400,
      bottom: top + height,
      width: 400,
      height,
      toJSON: () => ({}),
    }) as DOMRect
}

/** Триггер внутри композера — как в реальном композере чата. */
function makeComposer(composerTop: number): { composer: HTMLDivElement; trigger: HTMLButtonElement } {
  const composer = document.createElement('div')
  composer.className = 'chat-composer'
  const trigger = document.createElement('button')
  composer.appendChild(trigger)
  document.body.appendChild(composer)
  stubRect(composer, composerTop)
  return { composer, trigger }
}

async function mount(props: {
  open: boolean
  anchor: HTMLElement | null
  onClose?: () => void
  children?: React.ReactNode
}): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <MobileMenuSheet
        open={props.open}
        onClose={props.onClose ?? (() => {})}
        anchorRef={{ current: props.anchor }}
        ariaLabel="Список"
        header={<div data-testid="sheet-header">Шапка</div>}
      >
        {props.children ?? (
          <div>
            {Array.from({ length: 40 }, (_, index) => (
              <div key={index} data-row={index}>
                Пункт {index}
              </div>
            ))}
          </div>
        )}
      </MobileMenuSheet>,
    )
  })
  return container
}

function panel(): HTMLElement | null {
  return document.body.querySelector('[data-testid="mobile-menu-sheet"]')
}

beforeEach(() => {
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: VIEWPORT_HEIGHT })
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
  clearVisualViewport()
  if (originalInnerHeight) Object.defineProperty(window, 'innerHeight', originalInnerHeight)
  vi.useRealTimers()
})

describe('MobileMenuSheet: фиксированная панель вместо поппера', () => {
  it('закрытая панель ничего не рендерит', async () => {
    const { trigger } = makeComposer(600)
    await mount({ open: false, anchor: trigger })
    expect(panel()).toBeNull()
  })

  it('рендерится в портале как fixed-элемент с role=menu и шапкой', async () => {
    const { trigger } = makeComposer(600)
    const container = await mount({ open: true, anchor: trigger })

    const sheet = panel()!
    expect(sheet).not.toBeNull()
    // Портал: панель вне React-контейнера, прямо в body.
    expect(container.contains(sheet)).toBe(false)
    expect(sheet.parentElement).toBe(document.body)
    expect(sheet.style.position).toBe('fixed')
    expect(sheet.className).toContain('z-50')
    expect(sheet.getAttribute('role')).toBe('menu')
    expect(sheet.getAttribute('aria-label')).toBe('Список')
    expect(sheet.querySelector('[data-testid="sheet-header"]')).not.toBeNull()
  })

  it('нижняя кромка прижата к верху композера, верх не выходит за экран', async () => {
    const { trigger } = makeComposer(600)
    await mount({ open: true, anchor: trigger })

    const sheet = panel()!
    // bottom = innerHeight - composerTop; maxHeight = остаток над композером
    // (600 - 0 - 2*8 = 584) — панель использует всё доступное место.
    expect(sheet.style.bottom).toBe('200px')
    expect(sheet.style.maxHeight).toBe('584px')
    expect(sheet.style.left).toBe('8px')
    expect(sheet.style.right).toBe('8px')
    // Панель целиком в пределах экрана.
    expect(VIEWPORT_HEIGHT - parseFloat(sheet.style.bottom) - parseFloat(sheet.style.maxHeight)).toBeGreaterThan(0)
  })

  it('при нехватке места панель занимает остаток над композером, а не уезжает за край', async () => {
    const { trigger } = makeComposer(200)
    await mount({ open: true, anchor: trigger })

    const sheet = panel()!
    // Остаток = 200 - 0 - 2*8 = 184 — панель занимает его целиком.
    expect(sheet.style.maxHeight).toBe('184px')
    expect(sheet.style.bottom).toBe('600px')
    expect(VIEWPORT_HEIGHT - parseFloat(sheet.style.bottom) - parseFloat(sheet.style.maxHeight)).toBe(16)
  })

  it('содержимое живёт во внутреннем скролл-контейнере', async () => {
    const { trigger } = makeComposer(600)
    await mount({ open: true, anchor: trigger })

    const scroll = panel()!.querySelector('[data-testid="mobile-menu-sheet-scroll"]') as HTMLElement
    expect(scroll).not.toBeNull()
    expect(scroll.className).toContain('overflow-y-auto')
    expect(scroll.className).toContain('overlay-scrollbar-target')
    // Все пункты в DOM — скроллится контейнер, а не «обрезается» список.
    expect(scroll.querySelectorAll('[data-row]').length).toBe(40)
  })

  it('позиция пересчитывается при resize (композер сдвинулся)', async () => {
    const { composer, trigger } = makeComposer(600)
    await mount({ open: true, anchor: trigger })
    expect(panel()!.style.bottom).toBe('200px')

    // Клавиатура закрылась/открылась — композер переехал выше.
    stubRect(composer, 500)
    await act(async () => {
      window.dispatchEvent(new Event('resize'))
    })
    expect(panel()!.style.bottom).toBe('300px')
  })

  it('позиция пересчитывается на visualViewport resize', async () => {
    const { composer, trigger } = makeComposer(600)
    const viewport = new EventTarget()
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport })
    try {
      await mount({ open: true, anchor: trigger })
      expect(panel()!.style.bottom).toBe('200px')

      stubRect(composer, 450)
      await act(async () => {
        viewport.dispatchEvent(new Event('resize'))
      })
      expect(panel()!.style.bottom).toBe('350px')
    } finally {
      Object.defineProperty(window, 'visualViewport', { configurable: true, value: undefined })
    }
  })

  it('слушатели событий снимаются на unmount', async () => {
    const { trigger } = makeComposer(600)
    const removeSpy = vi.spyOn(window, 'removeEventListener')
    const container = await mount({ open: true, anchor: trigger })

    const entry = roots.find((item) => item.container === container)!
    await act(async () => {
      entry.root.unmount()
    })
    roots.splice(roots.indexOf(entry), 1)
    container.remove()

    expect(panel()).toBeNull()
    const removed = removeSpy.mock.calls.map((call) => call[0])
    expect(removed).toContain('resize')
    expect(removed).toContain('orientationchange')
    removeSpy.mockRestore()
  })

  it('тап вне панели (backdrop) закрывает её', async () => {
    const { trigger } = makeComposer(600)
    const onClose = vi.fn()
    await mount({ open: true, anchor: trigger, onClose })

    const backdrop = document.body.querySelector('[data-testid="mobile-menu-sheet-backdrop"]') as HTMLElement
    expect(backdrop).not.toBeNull()
    await act(async () => {
      backdrop.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('Escape закрывает панель', async () => {
    const { trigger } = makeComposer(600)
    const onClose = vi.fn()
    await mount({ open: true, anchor: trigger, onClose })

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('без композера панель прижимается к низу экрана', () => {
    const geometry = measureSheetGeometry(null)
    expect(geometry.bottom).toBe(8)
    // Композера нет — доступна вся высота экрана минус зазоры.
    expect(geometry.maxHeight).toBe(VIEWPORT_HEIGHT - 2 * 8)
  })
})

describe('MobileMenuSheet: показ ждёт стабилизации layout после скрытия клавиатуры', () => {
  it('без открытой клавиатуры панель видна сразу, без задержки', async () => {
    const { trigger } = makeComposer(600)
    await mount({ open: true, anchor: trigger })

    const sheet = panel()!
    expect(sheet.dataset.revealed).toBe('true')
    expect(sheet.style.visibility).toBe('visible')
    expect(sheet.style.pointerEvents).toBe('auto')
    expect(sheet.style.opacity).toBe('1')
    // Позиция посчитана сразу, как и раньше.
    expect(sheet.style.bottom).toBe('200px')
  })

  it('visualViewport совпадает с layout-окном (десктоп) — панель тоже видна сразу', async () => {
    installVisualViewport(VIEWPORT_HEIGHT)
    const { trigger } = makeComposer(600)
    await mount({ open: true, anchor: trigger })

    const sheet = panel()!
    expect(sheet.dataset.revealed).toBe('true')
    expect(sheet.style.visibility).toBe('visible')
    expect(sheet.style.bottom).toBe('200px')
  })

  it('при открытой клавиатуре панель скрыта, а после стабилизации встаёт по новому положению композера', async () => {
    // Layout-окно высокое, видимая область сжата клавиатурой — как на Android
    // при наборе текста (композер поднят клавиатурой).
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 })
    const viewport = installVisualViewport(500)
    const { composer, trigger } = makeComposer(400)
    await mount({ open: true, anchor: trigger })

    // Панель уже в DOM (замеры и виртуализатор работают), но не видна и не
    // принимает тапы: layout ещё промежуточный.
    const waiting = panel()!
    expect(waiting).not.toBeNull()
    expect(waiting.dataset.revealed).toBe('false')
    expect(waiting.style.visibility).toBe('hidden')
    expect(waiting.style.pointerEvents).toBe('none')
    expect(waiting.style.opacity).toBe('0')
    // Промежуточная позиция — именно та, из которой панель «уезжала» вниз.
    expect(waiting.style.bottom).toBe('500px')
    expect(waiting.style.maxHeight).toBe('384px')

    // Клавиатура ещё скрывается: видимая область растёт, но до layout-окна не
    // дошла — панель остаётся скрытой (никакой промежуточной отрисовки).
    stubRect(composer, 500)
    viewport.height = 700
    await act(async () => {
      viewport.dispatchEvent(new Event('resize'))
    })
    expect(panel()!.dataset.revealed).toBe('false')
    expect(panel()!.style.visibility).toBe('hidden')

    // Клавиатура закрылась: композер опустился на своё место.
    stubRect(composer, 700)
    viewport.height = 900
    await act(async () => {
      viewport.dispatchEvent(new Event('resize'))
    })

    const revealed = panel()!
    expect(revealed.dataset.revealed).toBe('true')
    expect(revealed.style.visibility).toBe('visible')
    expect(revealed.style.pointerEvents).toBe('auto')
    expect(revealed.style.opacity).toBe('1')
    // Низ — по НОВОМУ положению композера (900 - 700): промежуточный кадр не
    // показывался, панель проявилась уже на финальном месте.
    expect(revealed.style.bottom).toBe('200px')
    expect(revealed.style.maxHeight).toBe('684px')
    // Проявление — только прозрачность, геометрия не анимируется.
    expect(revealed.style.transition).toContain('opacity')
    expect(revealed.style.transition).toContain('120ms')
  })

  it('повторные resize после показа не меняют позицию без нужды (no-op при той же геометрии)', async () => {
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 })
    const viewport = installVisualViewport(900)
    const { composer, trigger } = makeComposer(700)
    await mount({ open: true, anchor: trigger })
    expect(panel()!.style.bottom).toBe('200px')

    // Композер на месте, «сжатие» уже прошло — геометрия та же.
    const before = panel()
    await act(async () => {
      viewport.dispatchEvent(new Event('resize'))
      window.dispatchEvent(new Event('resize'))
    })
    expect(panel()).toBe(before)
    expect(panel()!.style.bottom).toBe('200px')

    // А реальный сдвиг композера по-прежнему пересчитывается.
    stubRect(composer, 600)
    await act(async () => {
      viewport.dispatchEvent(new Event('resize'))
    })
    expect(panel()!.style.bottom).toBe('300px')
  })

  it('без события стабилизации панель проявляется по страховочному таймауту', async () => {
    // Клавиатура уже ушла, но событие не пришло (iOS, десктопные эмуляции) —
    // работает страховка по времени.
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 })
    const viewport = installVisualViewport(500)
    const { composer, trigger } = makeComposer(400)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await mount({ open: true, anchor: trigger })
    expect(panel()!.dataset.revealed).toBe('false')

    // Layout уже финальный (видимая область выросла), но resize не пришёл:
    // только высота меняется, событие не диспатчится.
    viewport.height = 900
    stubRect(composer, 700)
    await act(async () => {
      vi.advanceTimersByTime(400)
    })

    const sheet = panel()!
    expect(sheet.dataset.revealed).toBe('true')
    expect(sheet.style.visibility).toBe('visible')
    expect(sheet.style.pointerEvents).toBe('auto')
    expect(sheet.style.bottom).toBe('200px')
  })

  it('страховка не показывает панель, пока layout ещё сжат, но и не держит её скрытой бесконечно', async () => {
    // Медленное устройство: клавиатура уходит дольше страховочного тика.
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 })
    const viewport = installVisualViewport(500)
    const { composer, trigger } = makeComposer(400)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await mount({ open: true, anchor: trigger })

    // Первый тик: видимая область всё ещё сжата — панель остаётся скрытой,
    // иначе она встала бы в промежуточную позицию и «прыгнула» вниз.
    await act(async () => {
      vi.advanceTimersByTime(400)
    })
    expect(panel()!.dataset.revealed).toBe('false')

    // Второй тик упирается в предел ожидания: показываем по текущему layout.
    viewport.height = 900
    stubRect(composer, 700)
    await act(async () => {
      vi.advanceTimersByTime(400)
    })
    expect(panel()!.dataset.revealed).toBe('true')
    expect(panel()!.style.bottom).toBe('200px')
  })
})
