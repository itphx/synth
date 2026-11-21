/**
 * Мобильный лист списка композера (`MobileMenuSheet`) — единый для трёх списков:
 * модель, агент, уровень размышлений.
 *
 * Проверяется контракт панели:
 * - портал в `body`, `position: fixed`, шапка не скроллится, содержимое — внутри;
 * - **зазор над кнопкой = зазору под кнопкой**: `low = trigger.top − (composer.bottom
 *   − trigger.bottom)` (с ограничением 4…16px на развёрнутом композере);
 * - **ширина уже поля ввода** в режиме `'composer'`: `left/right` = отступы
 *   композера + 8px, то есть панель на 16px уже `.chat-composer`;
 * - режим `'content'` (размышления): ширина по содержимому (минимум 140px, не
 *   шире композера − 16px), правый край — по правому краю кнопки;
 * - места мало — панель прижимается, но не выходит за верхнюю кромку экрана;
 * - **панель видна на первом кадре** (`visibility`/`opacity` не трогаем — ожидания
 *   стабилизации layout больше нет) и следит за кнопкой пока едет композер;
 * - пересчёт геометрии на `resize`/`visualViewport`/`scroll` (с догоном через два
 *   `requestAnimationFrame`), no-op при неизменной геометрии;
 * - закрытие — тап вне (`backdrop`), `Escape`; тап по прямоугольнику кнопки тоже
 *   закрывает (backdrop лежит поверх неё) и метит парный `click`, иначе список
 *   открывался бы заново — «моргание»;
 * - **карантин открытия** (`SHEET_OPEN_QUARANTINE_MS`): в первые ~380 мс backdrop
 *   не закрывает панель вообще — так гасится дребезг тапа, который Android шлёт
 *   после скрытия клавиатуры (он попадает в backdrop, лежащий поверх кнопки);
 * - **содержимое не пересоздаётся при смене геометрии**: серия ресайзов меняет
 *   только инлайновые стили панели — тело списка не перерисовывается (memo-граница),
 *   строки остаются теми же DOM-узлами, прокрутка не сбрасывается, полоса
 *   прокрутки не исчезает.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import {
  MobileMenuSheet,
  SHEET_OPEN_QUARANTINE_MS,
  measureSheetGeometry,
  measureTriggerGap,
  useTriggerGap,
} from './MobileMenuSheet'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** Как на живом стенде: телефон 412×915. */
const VIEWPORT_WIDTH = 412
const VIEWPORT_HEIGHT = 915
/** Композер на телефоне: `w-4/5` по центру. */
const COMPOSER_LEFT = 12
const COMPOSER_RIGHT = 400
const COMPOSER_WIDTH = COMPOSER_RIGHT - COMPOSER_LEFT
const COMPOSER_TOP = 760
const COMPOSER_HEIGHT = 56
const COMPOSER_BOTTOM = COMPOSER_TOP + COMPOSER_HEIGHT
/** Кнопка-триггер в тулбаре композера — от её верха отсчитывается низ панели. */
const TRIGGER_TOP = 780
const TRIGGER_HEIGHT = 28
const TRIGGER_BOTTOM = TRIGGER_TOP + TRIGGER_HEIGHT
/** Зазор под кнопкой внутри композера: 816 − 808 = 8px. */
const GAP_BELOW = COMPOSER_BOTTOM - TRIGGER_BOTTOM

const originalInnerHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight')
const originalInnerWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth')
const roots: Array<{ root: Root; container: HTMLElement }> = []

/**
 * Кадры под ручным управлением: на них держится слежение за кнопкой (покадровый
 * пересчёт после открытия), поэтому тест прогоняет их сам.
 */
let rafSeq = 0
let rafQueue = new Map<number, FrameRequestCallback>()

function installFrames(): void {
  rafSeq = 0
  rafQueue = new Map()
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = ++rafSeq
    rafQueue.set(id, callback)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    rafQueue.delete(id)
  })
}

/** Прогнать накопленные кадры (внутри `act`, чтобы React применил setState). */
async function flushFrames(count = 1): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    const pending = Array.from(rafQueue.values())
    rafQueue.clear()
    await act(async () => {
      for (const callback of pending) callback(0)
    })
  }
}

/** Искусственный `visualViewport`: jsdom его не реализует. */
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

interface StubRect {
  top: number
  left?: number
  right?: number
  height?: number
}

/** jsdom не считает layout: прямоугольник задаётся точечно на элементе. */
function stubRect(element: HTMLElement, rect: StubRect): void {
  const left = rect.left ?? 0
  const right = rect.right ?? 400
  const height = rect.height ?? 120
  element.getBoundingClientRect = () =>
    ({
      x: left,
      y: rect.top,
      top: rect.top,
      left,
      right,
      bottom: rect.top + height,
      width: right - left,
      height,
      toJSON: () => ({}),
    }) as DOMRect
}

/**
 * Композер с тулбаром и кнопкой — как в реальном `ChatInput`: панель шириной по
 * композеру, низ — над кнопкой на тот же зазор, что и под ней.
 */
function makeComposer(
  options: {
    composerTop?: number
    composerHeight?: number
    triggerTop?: number
    triggerLeft?: number
    triggerRight?: number
  } = {},
): {
  composer: HTMLDivElement
  toolbar: HTMLDivElement
  trigger: HTMLButtonElement
} {
  const composerTop = options.composerTop ?? COMPOSER_TOP
  const composerHeight = options.composerHeight ?? COMPOSER_HEIGHT
  const triggerTop = options.triggerTop ?? TRIGGER_TOP
  const triggerLeft = options.triggerLeft ?? COMPOSER_LEFT + 8
  const triggerRight = options.triggerRight ?? COMPOSER_LEFT + 40

  const composer = document.createElement('div')
  composer.className = 'chat-composer'
  const toolbar = document.createElement('div')
  toolbar.className = 'chat-toolbar'
  const trigger = document.createElement('button')
  toolbar.appendChild(trigger)
  composer.appendChild(toolbar)
  document.body.appendChild(composer)
  stubRect(composer, {
    top: composerTop,
    left: COMPOSER_LEFT,
    right: COMPOSER_RIGHT,
    height: composerHeight,
  })
  stubRect(toolbar, {
    top: triggerTop - 12,
    left: COMPOSER_LEFT,
    right: COMPOSER_RIGHT,
    height: 40,
  })
  stubRect(trigger, { top: triggerTop, left: triggerLeft, right: triggerRight, height: TRIGGER_HEIGHT })
  return { composer, toolbar, trigger }
}

async function mount(props: {
  open: boolean
  anchor: HTMLElement | null
  onClose?: () => void
  widthMode?: 'composer' | 'content'
  align?: 'start' | 'end'
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
        widthMode={props.widthMode}
        align={props.align}
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

function backdrop(): HTMLElement | null {
  return document.body.querySelector('[data-testid="mobile-menu-sheet-backdrop"]')
}

/**
 * «Переждать» карантин открытия: пока окно не истекло, backdrop тапы игнорирует
 * (так гасится дребезг Android после скрытия клавиатуры).
 */
function expireOpenQuarantine(): void {
  vi.advanceTimersByTime(SHEET_OPEN_QUARANTINE_MS + 20)
}

/** Тап по элементу с заданными координатами (как его бы прислал браузер). */
async function tapPointerDown(
  element: HTMLElement,
  point: { clientX: number; clientY: number },
): Promise<PointerEvent> {
  const event = new PointerEvent('pointerdown', {
    bubbles: true,
    cancelable: true,
    clientX: point.clientX,
    clientY: point.clientY,
  })
  await act(async () => {
    element.dispatchEvent(event)
  })
  return event
}

/** Низ панели над кнопкой (в координатах viewport): `bottom` — отступ от низа. */
function panelLow(sheet: HTMLElement): number {
  return VIEWPORT_HEIGHT - parseFloat(sheet.style.bottom)
}

beforeEach(() => {
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: VIEWPORT_HEIGHT })
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: VIEWPORT_WIDTH })
  installFrames()
  // Таймеры — под контролем: страховочный замер не должен срабатывать сам.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
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
  if (originalInnerWidth) Object.defineProperty(window, 'innerWidth', originalInnerWidth)
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('MobileMenuSheet: фиксированная панель вместо поппера', () => {
  it('закрытая панель ничего не рендерит', async () => {
    const { trigger } = makeComposer()
    await mount({ open: false, anchor: trigger })
    expect(panel()).toBeNull()
  })

  it('рендерится в портале как fixed-элемент с role=menu и шапкой', async () => {
    const { trigger } = makeComposer()
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

  it('панель видна на первом кадре: нет visibility: hidden и скрытого показа', async () => {
    const { trigger } = makeComposer()
    await mount({ open: true, anchor: trigger })

    // Кадры ещё не прогоняли — панель уже отрисована и видима.
    const sheet = panel()!
    expect(sheet).not.toBeNull()
    expect(sheet.dataset.revealed).toBe('true')
    expect(sheet.style.visibility).toBe('')
    expect(sheet.style.opacity).toBe('')
    expect(sheet.style.pointerEvents).toBe('')
    // Геометрия посчитана первым (layout) замером, а не «нулевая».
    expect(sheet.style.bottom).toBe(`${VIEWPORT_HEIGHT - (TRIGGER_TOP - GAP_BELOW)}px`)
    expect(sheet.textContent).toContain('Пункт 0')
  })

  it('зазор над кнопкой равен зазору под кнопкой, ширина = композер − 16px', async () => {
    const { trigger } = makeComposer()
    await mount({ open: true, anchor: trigger })

    const sheet = panel()!
    // low = trigger.top − (composer.bottom − trigger.bottom) = 780 − 8 = 772.
    expect(panelLow(sheet)).toBe(TRIGGER_TOP - GAP_BELOW)
    expect(panelLow(sheet)).toBe(TRIGGER_TOP - (COMPOSER_BOTTOM - TRIGGER_BOTTOM))
    expect(sheet.style.bottom).toBe(`${VIEWPORT_HEIGHT - (TRIGGER_TOP - GAP_BELOW)}px`)
    // top = safe-top(0) + 8 = 8; maxHeight = 772 − 8 = 764.
    expect(sheet.style.maxHeight).toBe(`${TRIGGER_TOP - GAP_BELOW - 8}px`)
    // Ширина: отступы композера (12px) + 8px с каждой стороны.
    expect(sheet.style.left).toBe(`${COMPOSER_LEFT + 8}px`)
    expect(sheet.style.right).toBe(`${VIEWPORT_WIDTH - COMPOSER_RIGHT + 8}px`)
    const width = VIEWPORT_WIDTH - parseFloat(sheet.style.left) - parseFloat(sheet.style.right)
    expect(width).toBe(COMPOSER_WIDTH - 16)
    // Панель целиком в пределах экрана и выше кнопки.
    expect(panelLow(sheet)).toBeLessThan(TRIGGER_TOP)
    expect(panelLow(sheet) - parseFloat(sheet.style.maxHeight)).toBeGreaterThanOrEqual(0)
    // В режиме `'composer'` ширина задана отступами, а не по содержимому.
    expect(sheet.style.maxWidth).toBe('')
    expect(sheet.style.minWidth).toBe('')
  })

  it('зазор симметричен и на дробной геометрии (живые замеры телефона)', () => {
    // Реальные координаты с живого стенда: кнопка и композер стоят на дробных px.
    const { composer, trigger } = makeComposer()
    stubRect(composer, { top: 447.66, left: COMPOSER_LEFT, right: COMPOSER_RIGHT, height: 73.66 })
    stubRect(trigger, { top: 487.03, left: COMPOSER_LEFT + 8, right: COMPOSER_LEFT + 40, height: 23.8 })

    const geometry = measureSheetGeometry(trigger)
    const panelBottom = VIEWPORT_HEIGHT - geometry.bottom
    const gapAbove = 487.03 - panelBottom
    const gapBelow = 447.66 + 73.66 - (487.03 + 23.8)

    // Округление не должно сдвигать зазор: над кнопкой ровно столько же, сколько под ней.
    expect(gapAbove).toBeCloseTo(gapBelow, 5)
    expect(gapAbove).toBeCloseTo(10.49, 5)
  })

  it('на развёрнутом композере зазор ограничен сверху (24px)', async () => {
    // Развёрнутый композер: от кнопки до низа композера 900 − 808 = 92px —
    // панель не должна уезжать вниз на все 92px, иначе перекроет поле ввода.
    const { trigger } = makeComposer({ composerHeight: 140 })
    await mount({ open: true, anchor: trigger })

    const sheet = panel()!
    expect(COMPOSER_TOP + 140 - TRIGGER_BOTTOM).toBe(92)
    expect(panelLow(sheet)).toBe(TRIGGER_TOP - 24)
  })

  it('при нехватке места панель занимает минимум, но не выходит за верх экрана', async () => {
    const { trigger } = makeComposer({ composerTop: 56, composerHeight: 60, triggerTop: 60 })
    await mount({ open: true, anchor: trigger })

    const sheet = panel()!
    // Зазор под кнопкой (116 − 88 = 28px) обрезан до 24 → low = 36, top = 8:
    // места 28px < минимума 96 — панель не выше экрана (36).
    expect(panelLow(sheet)).toBe(60 - 24)
    expect(sheet.style.maxHeight).toBe('36px')
    expect(VIEWPORT_HEIGHT - parseFloat(sheet.style.bottom) - parseFloat(sheet.style.maxHeight)).toBe(0)
  })

  it('содержимое живёт во внутреннем скролл-контейнере', async () => {
    const { trigger } = makeComposer()
    await mount({ open: true, anchor: trigger })

    const scroll = panel()!.querySelector('[data-testid="mobile-menu-sheet-scroll"]') as HTMLElement
    expect(scroll).not.toBeNull()
    expect(scroll.className).toContain('overflow-y-auto')
    expect(scroll.className).toContain('overlay-scrollbar-target')
    // Все пункты в DOM — скроллится контейнер, а не «обрезается» список.
    expect(scroll.querySelectorAll('[data-row]').length).toBe(40)
  })

  it('без композера панель прижимается к низу экрана (fallback отступов)', () => {
    const geometry = measureSheetGeometry(null)
    expect(geometry.bottom).toBe(8)
    expect(geometry.maxHeight).toBe(VIEWPORT_HEIGHT - 2 * 8)
    expect(geometry.left).toBe(8)
    expect(geometry.right).toBe(8)
    expect(geometry.maxWidth).toBeNull()
  })

  it('позиция пересчитывается при resize (кнопка и композер сдвинулись)', async () => {
    const { composer, toolbar, trigger } = makeComposer()
    await mount({ open: true, anchor: trigger })
    expect(panel()!.style.bottom).toBe(`${VIEWPORT_HEIGHT - (TRIGGER_TOP - GAP_BELOW)}px`)

    // Клавиатура закрылась/открылась — композер вместе с кнопкой переехал выше.
    stubRect(composer, { top: 700, left: COMPOSER_LEFT, right: COMPOSER_RIGHT, height: COMPOSER_HEIGHT })
    stubRect(toolbar, { top: 668, left: COMPOSER_LEFT, right: COMPOSER_RIGHT, height: 40 })
    stubRect(trigger, { top: 680, left: COMPOSER_LEFT + 8, right: COMPOSER_LEFT + 40, height: TRIGGER_HEIGHT })
    await act(async () => {
      window.dispatchEvent(new Event('resize'))
    })
    // Пересчёт догоняющий: событие приходит до коммита React, поэтому через два кадра.
    await flushFrames(2)
    // Зазор под кнопкой не изменился (756 − 708 = 48 → обрезан до 24).
    expect(panel()!.style.bottom).toBe(`${VIEWPORT_HEIGHT - (680 - 24)}px`)
  })

  it('позиция пересчитывается на visualViewport resize и scroll документа', async () => {
    const { composer, toolbar, trigger } = makeComposer()
    const viewport = installVisualViewport(VIEWPORT_HEIGHT)
    await mount({ open: true, anchor: trigger })
    expect(panel()!.style.bottom).toBe(`${VIEWPORT_HEIGHT - (TRIGGER_TOP - GAP_BELOW)}px`)

    stubRect(composer, { top: 700, left: COMPOSER_LEFT, right: COMPOSER_RIGHT, height: COMPOSER_HEIGHT })
    stubRect(toolbar, { top: 668, left: COMPOSER_LEFT, right: COMPOSER_RIGHT, height: 40 })
    stubRect(trigger, { top: 680, left: COMPOSER_LEFT + 8, right: COMPOSER_LEFT + 40, height: TRIGGER_HEIGHT })
    await act(async () => {
      viewport.dispatchEvent(new Event('resize'))
    })
    await flushFrames(2)
    expect(panel()!.style.bottom).toBe(`${VIEWPORT_HEIGHT - (680 - 24)}px`)

    // Прокрутка документа — тоже повод пересчитать (зазор под кнопкой = 8).
    stubRect(composer, { top: 700, left: COMPOSER_LEFT, right: COMPOSER_RIGHT, height: 36 })
    stubRect(trigger, { top: 700, left: COMPOSER_LEFT + 8, right: COMPOSER_LEFT + 40, height: 28 })
    await act(async () => {
      document.dispatchEvent(new Event('scroll'))
    })
    await flushFrames(2)
    expect(panel()!.style.bottom).toBe(`${VIEWPORT_HEIGHT - (700 - 8)}px`)
  })

  it('после открытия панель следит за кнопкой без событий (клавиатура гаснет)', async () => {
    const { composer, toolbar, trigger } = makeComposer()
    await mount({ open: true, anchor: trigger })
    expect(panel()!.style.bottom).toBe(`${VIEWPORT_HEIGHT - (TRIGGER_TOP - GAP_BELOW)}px`)

    // Композер и кнопка поехали вниз (клавиатура скрылась) — событий не шлём:
    // покадровое слежение в первые ~600 мс подхватывает новую позицию само.
    stubRect(composer, { top: 820, left: COMPOSER_LEFT, right: COMPOSER_RIGHT, height: COMPOSER_HEIGHT })
    stubRect(toolbar, { top: 828, left: COMPOSER_LEFT, right: COMPOSER_RIGHT, height: 40 })
    stubRect(trigger, { top: 840, left: COMPOSER_LEFT + 8, right: COMPOSER_LEFT + 40, height: TRIGGER_HEIGHT })
    await flushFrames(1)

    // Новый зазор под кнопкой: 876 − 868 = 8.
    expect(panelLow(panel()!)).toBe(840 - 8)
  })

  it('слушатели событий снимаются на unmount', async () => {
    const { trigger } = makeComposer()
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

  it('тап вне панели (backdrop) закрывает её и гасит совместимый click', async () => {
    const { trigger } = makeComposer()
    const onClose = vi.fn()
    await mount({ open: true, anchor: trigger, onClose })
    // Карантин открытия уже истёк — теперь тап вне закрывает панель.
    expireOpenQuarantine()

    const event = new MouseEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      clientX: 300,
      clientY: 300,
    })
    await act(async () => {
      backdrop()!.dispatchEvent(event)
    })
    expect(onClose).toHaveBeenCalledTimes(1)
    // Без preventDefault тап по кнопке закрыл бы список и тут же открыл его снова.
    expect(event.defaultPrevented).toBe(true)
  })

  it('тап по прямоугольнику кнопки закрывает панель и помечает парный click', async () => {
    const { trigger } = makeComposer()
    const onClose = vi.fn()
    await mount({ open: true, anchor: trigger, onClose })
    expireOpenQuarantine()

    // Центр кнопки: x = (20 + 52) / 2 = 36, y = 780 + 14 = 794.
    const event = await tapPointerDown(backdrop()!, { clientX: 36, clientY: 794 })

    // Backdrop лежит поверх кнопки, поэтому тап по её прямоугольнику приходит
    // сюда: закрываем панель и гасим click (в селекторах он не откроет список).
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(event.defaultPrevented).toBe(true)
  })

  it('Escape закрывает панель', async () => {
    const { trigger } = makeComposer()
    const onClose = vi.fn()
    await mount({ open: true, anchor: trigger, onClose })

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('повторные resize не пересоздают состояние без изменения геометрии', async () => {
    const { trigger } = makeComposer()
    const viewport = installVisualViewport(VIEWPORT_HEIGHT)
    await mount({ open: true, anchor: trigger })
    expect(panel()!.style.bottom).toBe(`${VIEWPORT_HEIGHT - (TRIGGER_TOP - GAP_BELOW)}px`)

    const before = panel()
    // Догоняющее слежение за кнопкой уже отработало — дальше только события.
    await flushFrames(40)
    await act(async () => {
      viewport.dispatchEvent(new Event('resize'))
      window.dispatchEvent(new Event('resize'))
    })
    await flushFrames(2)
    expect(panel()).toBe(before)
    expect(panel()!.style.bottom).toBe(`${VIEWPORT_HEIGHT - (TRIGGER_TOP - GAP_BELOW)}px`)
  })
})

/**
 * Карантин открытия.
 *
 * Живой Android: тап по кнопке открывает панель, клавиатура начинает гаснуть, и
 * после `blur` браузер повторяет тап (`pointerdown` по тем же координатам).
 * Backdrop смонтирован в кадре открытия поверх кнопки, поэтому дребезг приходил
 * в него — и панель закрывалась вместе со скрытием клавиатуры (баг владельца).
 */
describe('MobileMenuSheet: карантин открытия', () => {
  it('повторный тап вне панели сразу после открытия не закрывает её', async () => {
    const { trigger } = makeComposer()
    const onClose = vi.fn()
    await mount({ open: true, anchor: trigger, onClose })

    const event = await tapPointerDown(backdrop()!, { clientX: 300, clientY: 300 })

    // Дребезг после скрытия клавиатуры: панель жива, тап погашен (не дошёл до композера).
    expect(onClose).not.toHaveBeenCalled()
    expect(panel()).not.toBeNull()
    expect(event.defaultPrevented).toBe(true)
  })

  it('серия повторов тапа в первые 300 мс не роняет панель', async () => {
    const { trigger } = makeComposer()
    const onClose = vi.fn()
    await mount({ open: true, anchor: trigger, onClose })

    // Три повтора в пределах карантина — как дребезг Android после `blur`.
    for (let index = 0; index < 3; index += 1) {
      await tapPointerDown(backdrop()!, { clientX: 36, clientY: 794 })
      vi.advanceTimersByTime(100)
    }

    expect(onClose).not.toHaveBeenCalled()
    expect(panel()).not.toBeNull()
  })

  it('тап по прямоугольнику кнопки в карантине не закрывает и не помечает click', async () => {
    const { trigger } = makeComposer()
    const onClose = vi.fn()
    await mount({ open: true, anchor: trigger, onClose })

    // x = 36, y = 794 — центр кнопки.
    await tapPointerDown(backdrop()!, { clientX: 36, clientY: 794 })
    expect(onClose).not.toHaveBeenCalled()

    // После карантина тот же тап работает как тап по триггеру: панель закрывается.
    expireOpenQuarantine()
    await tapPointerDown(backdrop()!, { clientX: 36, clientY: 794 })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('Escape работает и во время карантина', async () => {
    const { trigger } = makeComposer()
    const onClose = vi.fn()
    await mount({ open: true, anchor: trigger, onClose })

    // Карантин глушит только тапы: клавиатура/скринридер должны работать сразу.
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

/**
 * Содержимое при изменении геометрии (Проблема B: «списки моргают»).
 *
 * Замер на живом стенде: сама панель при ресайзе не исчезает (`present/revealed`
 * стабильны), мигает **содержимое** — строки пересобираются. Здесь проверяется
 * обратное: при серии ресайзов меняются только инлайновые стили панели, а тело
 * списка не перерисовывается и не пересоздаётся.
 */
let bodyRenderCount = 0

/** Тело списка со счётчиком рендеров — доказательство memo-границы. */
function CountingBody(): React.ReactElement {
  bodyRenderCount += 1
  return (
    <div>
      {Array.from({ length: 40 }, (_, index) => (
        <div key={index} data-row={index}>
          Пункт {index}
        </div>
      ))}
    </div>
  )
}

describe('MobileMenuSheet: содержимое не пересоздаётся при ресайзе', () => {
  /** Прогнать ресайз с новой геометрией кнопки/композера. */
  async function resize(
    refs: { composer: HTMLElement; toolbar: HTMLElement; trigger: HTMLElement },
    tops: { composerTop: number; triggerTop: number },
    gap = GAP_BELOW,
  ): Promise<void> {
    stubRect(refs.composer, {
      top: tops.composerTop,
      left: COMPOSER_LEFT,
      right: COMPOSER_RIGHT,
      height: COMPOSER_HEIGHT,
    })
    stubRect(refs.toolbar, {
      top: tops.triggerTop - 12,
      left: COMPOSER_LEFT,
      right: COMPOSER_RIGHT,
      height: 40,
    })
    stubRect(refs.trigger, {
      top: tops.triggerTop,
      left: COMPOSER_LEFT + 8,
      right: COMPOSER_LEFT + 40,
      height: TRIGGER_HEIGHT,
    })
    expect(gap).toBe(GAP_BELOW)
    await act(async () => {
      window.dispatchEvent(new Event('resize'))
    })
    await flushFrames(2)
  }

  it('серия ресайзов: те же узлы строк, тот же скролл-контейнер, прокрутка сохранена', async () => {
    const refs = makeComposer()
    await mount({ open: true, anchor: refs.trigger })

    const panelBefore = panel()!
    const scrollBefore = panelBefore.querySelector('[data-testid="mobile-menu-sheet-scroll"]') as HTMLElement
    // jsdom не считает layout — прокрутку держим явным значением.
    let scrollTop = 180
    Object.defineProperty(scrollBefore, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value
      },
    })
    scrollBefore.scrollTop = 180
    const rowsBefore = Array.from(scrollBefore.querySelectorAll('[data-row]'))
    expect(rowsBefore).toHaveLength(40)

    // Клавиатура скрылась и вернулась, панель пересела дважды.
    await resize(refs, { composerTop: 700, triggerTop: 720 })
    await resize(refs, { composerTop: 760, triggerTop: 780 })

    const panelAfter = panel()!
    expect(panelAfter).toBe(panelBefore)
    expect(panelAfter.dataset.revealed).toBe('true')
    // Обновились только стили позиции/размера самой панели.
    expect(parseFloat(panelAfter.style.maxHeight)).toBeGreaterThan(0)
    expect(panelAfter.style.bottom).toBe(`${VIEWPORT_HEIGHT - (780 - GAP_BELOW)}px`)

    const scrollAfter = panelAfter.querySelector('[data-testid="mobile-menu-sheet-scroll"]') as HTMLElement
    expect(scrollAfter).toBe(scrollBefore)
    expect(scrollAfter.scrollTop).toBe(180)

    // Те же самые DOM-узлы: ни одного remount строк.
    const rowsAfter = Array.from(scrollAfter.querySelectorAll('[data-row]'))
    expect(rowsAfter).toHaveLength(rowsBefore.length)
    rowsBefore.forEach((node, index) => {
      expect(rowsAfter[index]).toBe(node)
    })
  })

  it('тело списка не перерисовывается от изменения геометрии (memo-граница)', async () => {
    const refs = makeComposer()
    bodyRenderCount = 0
    await mount({ open: true, anchor: refs.trigger, children: <CountingBody /> })
    expect(bodyRenderCount).toBe(1)

    await resize(refs, { composerTop: 700, triggerTop: 720 })
    await resize(refs, { composerTop: 620, triggerTop: 640 })

    // Геометрия обновлялась (стили панели менялись), а тело списка — ни разу.
    expect(panel()!.style.bottom).toBe(`${VIEWPORT_HEIGHT - (640 - GAP_BELOW)}px`)
    expect(bodyRenderCount).toBe(1)
  })

  it('полоса прокрутки не исчезает, пока контейнер без layout-бокса', async () => {
    const refs = makeComposer()
    await mount({ open: true, anchor: refs.trigger })

    const scroll = panel()!.querySelector('[data-testid="mobile-menu-sheet-scroll"]') as HTMLElement
    // jsdom не считает layout: размеры контейнера задаём сами.
    let clientHeight = 400
    let scrollHeight = 2000
    Object.defineProperty(scroll, 'clientHeight', { configurable: true, get: () => clientHeight })
    Object.defineProperty(scroll, 'scrollHeight', { configurable: true, get: () => scrollHeight })
    Object.defineProperty(scroll, 'clientWidth', { configurable: true, get: () => 380 })
    Object.defineProperty(scroll, 'scrollWidth', { configurable: true, get: () => 380 })

    await act(async () => {
      scroll.dispatchEvent(new Event('scroll'))
    })
    // Скролл-обработчик полосы схлопывается в кадр (rAF под ручным управлением).
    await flushFrames(1)
    const barBefore = panel()!.querySelector('.overlay-scrollbar')
    expect(barBefore).not.toBeNull()

    // Мимолётно нулевой прямоугольник при смене геометрии — метрики не сбрасываются.
    clientHeight = 0
    scrollHeight = 0
    await act(async () => {
      scroll.dispatchEvent(new Event('scroll'))
    })
    await flushFrames(1)
    expect(panel()!.querySelector('.overlay-scrollbar')).toBe(barBefore)

    // Геометрия вернулась — тот же узел полосы, а не новый (без мигания).
    clientHeight = 300
    scrollHeight = 2000
    await act(async () => {
      scroll.dispatchEvent(new Event('scroll'))
    })
    await flushFrames(1)
    expect(panel()!.querySelector('.overlay-scrollbar')).toBe(barBefore)
  })
})

describe('MobileMenuSheet: ширина по содержимому (режим content)', () => {
  it('правый край по кнопке, минимум 140px, не шире композера − 16px', async () => {
    // Кнопка в правой части тулбара — как у размышлений на живом стенде.
    const { trigger } = makeComposer({ triggerLeft: 250, triggerRight: 282 })
    await mount({ open: true, anchor: trigger, widthMode: 'content' })

    const sheet = panel()!
    expect(sheet.dataset.widthMode).toBe('content')
    // Правый край панели = правый край кнопки: 412 − 282 = 130.
    expect(sheet.style.right).toBe(`${VIEWPORT_WIDTH - 282}px`)
    // Левый отступ — `auto`: ширину по содержимому считает CSS.
    expect(sheet.style.left).toBe('')
    expect(parseFloat(sheet.style.minWidth)).toBe(140)
    // Потолок — композер − 16px (372) и не дальше левой кромки экрана (274).
    expect(parseFloat(sheet.style.maxWidth)).toBeLessThanOrEqual(COMPOSER_WIDTH - 16)
    expect(parseFloat(sheet.style.maxWidth)).toBe(VIEWPORT_WIDTH - (VIEWPORT_WIDTH - 282) - 8)
  })

  it('у левого края панель сдвигается, чтобы уложиться в минимум 140px', async () => {
    const { trigger } = makeComposer({ triggerLeft: 20, triggerRight: 52 })
    await mount({ open: true, anchor: trigger, widthMode: 'content' })

    const sheet = panel()!
    // Справа от кнопки (412 − 52 = 360) панель уехала бы за левый край:
    // правый отступ упирается в 412 − 140 − 8 = 264.
    expect(sheet.style.right).toBe(`${VIEWPORT_WIDTH - 140 - 8}px`)
    expect(VIEWPORT_WIDTH - parseFloat(sheet.style.right) - parseFloat(sheet.style.minWidth)).toBe(8)
    expect(parseFloat(sheet.style.maxWidth)).toBe(140)
  })

  it('вертикаль считается так же, как в режиме композера', async () => {
    const { trigger } = makeComposer({ triggerLeft: 250, triggerRight: 282 })
    await mount({ open: true, anchor: trigger, widthMode: 'content' })

    const sheet = panel()!
    expect(panelLow(sheet)).toBe(TRIGGER_TOP - GAP_BELOW)
    expect(sheet.style.maxHeight).toBe(`${TRIGGER_TOP - GAP_BELOW - 8}px`)
  })
})

/**
 * `measureTriggerGap` — общая формула зазора для листа и десктопных попперов.
 *
 * Проверяется то, ради чего она вынесена: значение зависит только от живого
 * layout (низ кнопки → низ `.chat-composer`) и симметрично зазору под кнопкой
 * в границах 4…24px.
 */
describe('measureTriggerGap: зазор над кнопкой = зазор под кнопкой', () => {
  it('равен отрезку под кнопкой (симметрия)', () => {
    const { trigger } = makeComposer()
    // Композер 760…816, кнопка 780…808 → под кнопкой 8px.
    expect(GAP_BELOW).toBe(8)
    expect(measureTriggerGap(trigger)).toBe(GAP_BELOW)
  })

  it('совпадает с низом панели листа (`low = trigger.top − gap`)', () => {
    const { trigger } = makeComposer()
    const geometry = measureSheetGeometry(trigger)
    expect(VIEWPORT_HEIGHT - geometry.bottom).toBe(TRIGGER_TOP - measureTriggerGap(trigger))
  })

  it('сохраняет дробные доли живого замера (не округляет)', () => {
    const { composer, trigger } = makeComposer()
    stubRect(composer, { top: 447.66, left: COMPOSER_LEFT, right: COMPOSER_RIGHT, height: 73.66 })
    stubRect(trigger, { top: 487.03, left: COMPOSER_LEFT + 8, right: COMPOSER_LEFT + 40, height: 23.8 })

    // Под кнопкой: 521.32 − 510.83 = 10.49 — столько же должно быть и над ней.
    const expected = 447.66 + 73.66 - (487.03 + 23.8)
    expect(measureTriggerGap(trigger)).toBeCloseTo(expected, 10)
  })

  it('снизу ограничен 4px (кнопка почти вплотную к низу композера)', () => {
    const { composer, trigger } = makeComposer()
    // Под кнопкой 1px — панель не должна прилипать к кнопке.
    stubRect(composer, { top: 760, left: COMPOSER_LEFT, right: COMPOSER_RIGHT, height: 49 })
    stubRect(trigger, { top: 780, left: COMPOSER_LEFT + 8, right: COMPOSER_LEFT + 40, height: 28 })
    expect(measureTriggerGap(trigger)).toBe(4)
  })

  it('сверху ограничен 24px (развёрнутый композер)', () => {
    const { trigger } = makeComposer({ composerHeight: 140 })
    // Под кнопкой 92px — без потолка панель уехала бы вниз на все 92px.
    expect(COMPOSER_TOP + 140 - TRIGGER_BOTTOM).toBe(92)
    expect(measureTriggerGap(trigger)).toBe(24)
  })

  it('без кнопки и без композера — минимальные 4px', () => {
    expect(measureTriggerGap(null)).toBe(4)

    // Кнопка вне композера: отрезок под кнопкой неизвестен — тоже минимум.
    const lonely = document.createElement('button')
    document.body.appendChild(lonely)
    stubRect(lonely, { top: 700, height: 28 })
    expect(measureTriggerGap(lonely)).toBe(4)
  })

  it('хук `useTriggerGap` меряет при открытии, до замера отдаёт 4px', async () => {
    const { trigger } = makeComposer()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push({ root, container })
    const anchorRef = { current: trigger }
    const probe = (open: boolean) => (
      <span data-testid="gap">
        <GapProbe open={open} anchorRef={anchorRef} />
      </span>
    )

    // Закрыто — значение не нужно, отдаётся минимум поппера.
    await act(async () => {
      root.render(probe(false))
    })
    expect(container.textContent).toBe('4')

    // Открытие: замер в layout-эффекте, то есть до отрисовки кадра.
    await act(async () => {
      root.render(probe(true))
    })
    expect(container.textContent).toBe(String(GAP_BELOW))
  })
})

/** Пробник хука: печатает `sideOffset`, который получил бы поппер. */
function GapProbe({
  open,
  anchorRef,
}: {
  open: boolean
  anchorRef: { current: HTMLElement | null }
}): React.ReactElement {
  return <>{useTriggerGap(open, anchorRef)}</>
}
