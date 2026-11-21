import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from 'react'
import { createPortal } from 'react-dom'
import { OverlayScrollbar } from './OverlayScrollbar'

/**
 * Мобильный лист списка (телефон/узкая колонка) — **единый** механизм показа
 * для всех списков композера: модель (`ModelSelector`), агент
 * (`AgentModeSelector`) и уровень размышлений (`ReasoningLevelSelector`).
 *
 * Почему не Radix-поппер `side="top"`: на телефоне высота видимой области
 * меняется уже **после** расчёта позиции (клавиатура закрывается/открывается,
 * layout «дышит»). Поппер считал позицию по промежуточному layout, панель
 * «прыгала» под палец, а верхними пунктами уходила за край экрана (внутреннего
 * скролла у поппера нет).
 *
 * Геометрия — как у поппера `side="top"`, но по живому layout:
 * - **низ панели = верх кнопки-триггера − зазор**, где зазор равен расстоянию от
 *   низа кнопки до низа `.chat-composer` (`composer.bottom − anchor.bottom`,
 *   ограничено 4…16px): интервал над кнопкой совпадает с интервалом под ней.
 *   Панель растёт вверх **от кнопки**, а не от верха композера: в развёрнутом
 *   композере (`expanded` — поле ввода на всю высоту, тулбар внизу) место над
 *   кнопками есть, а привязка к верху композера там бесполезна;
 * - **ширина** — режим `widthMode`: `'composer'` (по умолчанию) — уже поля ввода
 *   (`left/right` = отступы композера + 8px), `'content'` — по содержимому с
 *   минимумом 140px и выравниванием `align` по кнопке (для компактных списков,
 *   как прежний поппер размышлений), но не шире композера − 16px;
 * - `top = safe-area-top + 8`, `maxHeight = low − top`; если места меньше
 *   минимума (96px), панель всё равно показывает шапку и пару пунктов, но не
 *   выходит за верхнюю кромку экрана;
 * - при переполнении список скроллится **внутри** панели.
 *
 * **Показ не ждёт «стабилизации layout».** Панель видна сразу (замер — в
 * layout-эффекте, то есть до отрисовки первого кадра), а её позиция **следует за
 * кнопкой** ~600 мс после открытия (`FOLLOW_TRIGGER_MS`): клавиатура гаснет
 * 200–300 мс, композер вместе с кнопкой едет вниз, и панель едет вместе с ней, а
 * не проявляется отдельным «прыжком». Покадровое ожидание «ключа layout» и
 * `visibility: hidden` до стабилизации убраны: на Android при скрытии клавиатуры
 * кадровый цикл мог не набрать двух одинаковых кадров, и панель оставалась
 * скрытой до страховочного таймаута. Страховка осталась, но только как подстраховка
 * (`REVEAL_FALLBACK_MS` — один дополнительный замер, если первый попал в
 * промежуточный layout и события не пришли).
 *
 * Триггер переключается на `pointerdown`, а не на `click` (`sheetTriggerHandlers`):
 * - `click` на Android может вообще не прийти, если браузер погасил тап при
 *   скрытии клавиатуры, — открытие «висело» именно на нём;
 * - после закрытия панели по backdrop (он лежит **поверх** кнопки) приходит
 *   «эхо»-`click` уже по самой кнопке, и toggle по `click` открывал список
 *   заново — отсюда «моргание». Помечаем такой `click` подавленным, а остальные
 *   (`Enter`/`Space`, скринридер) отрабатываем как toggle-фолбэк.
 *
 * **Карантин открытия** (`SHEET_OPEN_QUARANTINE_MS`). Диагностика на живом
 * стенде (сценарий Android, 412×915): backdrop монтируется **в кадре открытия**
 * и лежит поверх кнопки — уже парный `pointerup` того же тапа приходит в него
 * (лог: `pointerup → div[mobile-menu-sheet-backdrop]`). Когда клавиатура гаснет,
 * Android повторяет тап (`pointerdown` по тем же координатам) — этот дребезг
 * попадал в backdrop, тот трактовал его как «тап мимо» и закрывал панель (а тап
 * по прямоугольнику кнопки — как «закрыть + подавить click»). Поэтому в первые
 * ~380 мс после открытия backdrop **не закрывает** панель и не помечает click:
 * дребезг после скрытия клавиатуры список больше не роняет. Карантин живёт
 * здесь, а не в селекторах, — поведение всех трёх списков (модель, агент,
 * размышления) обязано быть одинаковым.
 *
 * **Содержимое панели не пересоздаётся при смене геометрии.** Обновление позиции —
 * это `setState` геометрии, то есть ре-рендер самой панели; тело списка (шапка +
 * скролл-контейнер + полоса прокрутки) вынесено в мемоизированный `SheetBody`,
 * поэтому ресайз окна/вьюпорта, скрытие клавиатуры и изменение высоты панели
 * меняют **только** инлайновые стили панели: строки списка, их `key`,
 * скролл-контейнер и полоса прокрутки остаются теми же DOM-узлами (без
 * remount — без «моргания»).
 */

/** Зазор панели до краёв экрана и до поля ввода (панель уже композера на 2×8). */
const SHEET_GAP = 8
/** Минимальный зазор между низом панели и верхом кнопки-триггера. */
const TRIGGER_GAP_MIN = 4
/**
 * Максимальный зазор над кнопкой: на развёрнутом композере расстояние от кнопки
 * до его низа может быть большим, и панель уехала бы вниз, перекрывая поле ввода.
 * Потолок 24px покрывает реальные значения (14–17px на десктопе и телефоне), но
 * не даёт панели «прилипнуть» к центру развёрнутого поля.
 */
const TRIGGER_GAP_MAX = 24
/** Минимальная высота панели: шапка и пара пунктов. */
const MIN_SHEET_HEIGHT = 96
/** Минимальная ширина панели в режиме `'content'` (как `min-w-[8.75rem]` поппера). */
const CONTENT_MIN_WIDTH = 140
/**
 * Сколько после открытия позиция пересчитывается покадрово. Клавиатура гаснет
 * 200–300 мс, анимация сдвига композера — до ~400 мс; 600 мс покрывает оба.
 */
const FOLLOW_TRIGGER_MS = 600
/**
 * Страховочный замер: если первый попал в промежуточный layout, а событий
 * (`resize`/`visualViewport`) не было, позиция всё равно догонит layout.
 * Основной путь показа — первый кадр, а не этот таймаут.
 */
const REVEAL_FALLBACK_MS = 500
/**
 * Окно, в котором `click` считается «эхом» нашего `pointerdown`. Ограничение по
 * времени нужно, чтобы не потерянный браузером `click` (Android при скрытии
 * клавиатуры) не съел следующую клавиатурную активацию (`Enter`/`Space`).
 */
const CLICK_SUPPRESS_MS = 700
/**
 * «Карантин открытия»: сколько после открытия backdrop игнорирует тапы.
 *
 * Android после `blur` (скрытие клавиатуры) повторяет тап по тем же координатам;
 * backdrop смонтирован поверх кнопки с первого кадра, поэтому дребезг приходил в
 * него и закрывал панель. 380 мс покрывают скрытие клавиатуры (200–300 мс) вместе
 * с хвостом анимации композера. Экспортируется для тестов: окно нужно «переждать»
 * прежде чем тап вне панели снова закрывает её.
 */
export const SHEET_OPEN_QUARANTINE_MS = 380

const SAFE_TOP_VAR = '--synth-safe-area-top'
const SAFE_LEFT_VAR = '--synth-safe-area-left'
const SAFE_RIGHT_VAR = '--synth-safe-area-right'

export type SheetWidthMode = 'composer' | 'content'
export type SheetAlign = 'start' | 'end'

/**
 * Классы подсветки открытого триггера — общие для всех трёх списков композера,
 * чтобы активная кнопка читалась одинаково. Рядом с классом ставится маркер
 * `data-sheet-open` (см. `sheetTriggerOpenProps`), программный признак для
 * тестов и отладки.
 */
export const MOBILE_SHEET_TRIGGER_OPEN_CLASS = 'text-primary bg-primary/10'

/**
 * Атрибуты/класс открытого триггера одним объектом — чтобы селекторы не
 * расходились в разметке (подсветка + маркер + `aria-expanded`).
 */
export function sheetTriggerOpenProps(open: boolean): {
  'data-sheet-open'?: 'true'
  className: string
} {
  return {
    ...(open ? { 'data-sheet-open': 'true' as const } : {}),
    className: open ? MOBILE_SHEET_TRIGGER_OPEN_CLASS : '',
  }
}

/**
 * Метка «следующий click по триггеру — эхо уже обработанного pointerdown».
 *
 * Состояние модульное, а не в замыкании компонента: `sheetTriggerHandlers` — не
 * хук (его вызывают в условной мобильной ветке селекторов), а закрытие по
 * backdrop вообще происходит вне триггера: метку ставит тот, кто обработал тап,
 * а читает обработчик клика. Одновременно открыт только один лист, поэтому
 * одного флага достаточно.
 */
let suppressedClickAt = 0

/** Пометить следующий click по триггеру как «эхо» обработанного pointerdown. */
function suppressNextTriggerClick(): void {
  suppressedClickAt = Date.now()
}

/** Погасить «эхо»-click: `true` — этот клик уже отработан pointerdown-ом. */
function consumeSuppressedClick(): boolean {
  if (!suppressedClickAt) return false
  const fresh = Date.now() - suppressedClickAt < CLICK_SUPPRESS_MS
  suppressedClickAt = 0
  return fresh
}

export interface SheetTriggerToggle {
  /** Открыт ли список сейчас (на момент рендера обработчиков). */
  open: boolean
  onOpen: () => void
  onClose: () => void
}

export interface SheetTriggerHandlers {
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void
  onClick: (event: ReactMouseEvent<HTMLElement>) => void
}

/**
 * Обработчики триггера списка: переключение по `pointerdown` + подавление
 * парного `click`.
 *
 * Почему `pointerdown`, а не `click`: на Android при скрытии клавиатуры `click`
 * по кнопке может не прийти вовсе (браузер гасит тап), и список не открывался.
 * `pointerdown` приходит всегда.
 *
 * Почему подавляем `click`: после закрытия по backdrop (он лежит поверх кнопки)
 * браузер доставляет «эхо»-клик уже по самой кнопке; без подавления toggle
 * открывал список заново — панель «моргала». Клавиатурная активация
 * (`Enter`/`Space`, скринридер) приходит без `pointerdown` — для неё остаётся
 * обычный toggle.
 */
export function sheetTriggerHandlers({
  open,
  onOpen,
  onClose,
}: SheetTriggerToggle): SheetTriggerHandlers {
  const toggle = (): void => {
    if (open) onClose()
    else onOpen()
  }
  return {
    onPointerDown: () => {
      // Клавиатура должна начать скрываться до замера позиции панели.
      blurActiveElement()
      suppressNextTriggerClick()
      toggle()
    },
    onClick: () => {
      // Парный клик того же тапа — уже переключились по pointerdown.
      if (consumeSuppressedClick()) return
      toggle()
    },
  }
}

export interface SheetGeometry {
  /**
   * Отступ слева (`null` — ширина по содержимому, тогда отступ задаёт `right`).
   */
  left: number | null
  /** Отступ справа (`null` — ширина по содержимому, отступ задаёт `left`). */
  right: number | null
  bottom: number
  maxHeight: number
  /** Потолок ширины (`null` — ширина задана отступами, как в режиме `'composer'`). */
  maxWidth: number | null
}

export interface SheetGeometryOptions {
  widthMode?: SheetWidthMode
  align?: SheetAlign
}

/**
 * Значение safe-area в px. В CSS переменные наполняются `env(safe-area-inset-*)`
 * (design-system.css); читаем их из computed style, потому что для `max-height`
 * нужна арифметика. Нет переменной (SSR/jsdom/браузер без вырезов) — 0.
 */
function readSafeInset(name: string): number {
  if (typeof window === 'undefined' || typeof document === 'undefined') return 0
  const value = Number.parseFloat(
    window.getComputedStyle(document.documentElement).getPropertyValue(name),
  )
  return Number.isFinite(value) && value > 0 ? value : 0
}

/** Ширина viewport (layout-окно): `innerWidth`, иначе ширина документа. */
function viewportWidth(): number {
  if (typeof window === 'undefined') return 0
  return window.innerWidth || document.documentElement?.clientWidth || 0
}

/** Ближайший композер — источник ширины панели и зазора под кнопкой. */
function composerOf(anchor: HTMLElement | null): HTMLElement | null {
  return (anchor?.closest('.chat-composer') as HTMLElement | null) ?? null
}

/**
 * Зазор между низом панели и верхом кнопки.
 *
 * Владелец: «интервал над кнопкой надо сделать равным интервалу под кнопкой».
 * Берём его из геометрии, а не константой: расстояние от низа кнопки до низа
 * `.chat-composer` (внутренние отступы поля ввода растут вместе с темой и
 * safe-area). Ограничиваем 4…16px: на развёрнутом композере этот отрезок
 * большой, и без потолка панель уехала бы вниз, перекрывая поле ввода.
 */
function triggerGap(anchorRect: DOMRect | null, composerRect: DOMRect | null): number {
  if (!anchorRect || !composerRect) return TRIGGER_GAP_MIN
  const below = composerRect.bottom - anchorRect.bottom
  if (!Number.isFinite(below)) return TRIGGER_GAP_MIN
  // Без округления: зазор должен совпасть с отрезком под кнопкой до пикселя.
  return Math.min(Math.max(below, TRIGGER_GAP_MIN), TRIGGER_GAP_MAX)
}

/**
 * Зазор над кнопкой-триггером по живому layout: ровно тот же отрезок, что и под
 * кнопкой (низ кнопки → низ `.chat-composer`), с ограничением 4…24px.
 *
 * Экспортируется, потому что зазор нужен **двум** механизмам: мобильному листу
 * (низ панели = верх кнопки − зазор) и десктопным попперам (`sideOffset`
 * `DropdownMenu.Content`) — формула должна быть одна, иначе расстояния над и под
 * кнопкой разъедутся. Нет композера/кнопки — минимум 4px (поппер не должен
 * прилипать к кнопке).
 */
export function measureTriggerGap(anchor: HTMLElement | null): number {
  const anchorRect = anchor?.getBoundingClientRect() ?? null
  const composerRect = composerOf(anchor)?.getBoundingClientRect() ?? null
  return triggerGap(anchorRect, composerRect)
}

/**
 * `sideOffset` десктопного поппера: зазор под кнопкой, измеренный **при
 * открытии** (не на каждом кадре — десктопный поппер не следует за кнопкой,
 * Radix позиционирует его сам).
 *
 * `open` — нужен ли зазор вообще: мобильной ветке он не нужен (там его считает
 * сам лист), поэтому селекторы передают `open && !isMobile` — на телефоне нет
 * ни лишнего замера, ни лишнего рендера.
 *
 * `null` — триггер ещё не измерен (первый кадр открытия), тогда отдаём минимум
 * 4px: пересчёт идёт layout-эффектом, то есть до отрисовки кадра, и скачка
 * «4 → зазор» не видно. Закрытие сбрасывает значение: к следующему открытию
 * layout мог уехать (тема, safe-area, развёрнутый композер).
 */
export function useTriggerGap(open: boolean, anchorRef: RefObject<HTMLElement | null>): number {
  const [gap, setGap] = useState<number | null>(null)
  useLayoutEffect(() => {
    setGap(open ? measureTriggerGap(anchorRef.current) : null)
  }, [open, anchorRef])
  return gap ?? TRIGGER_GAP_MIN
}

/**
 * Геометрия панели по текущему положению триггера и композера.
 *
 * Экспортируется для тестов: чистая функция от `getBoundingClientRect` и
 * viewport, без подписки на события.
 */
export function measureSheetGeometry(
  anchor: HTMLElement | null,
  options: SheetGeometryOptions = {},
): SheetGeometry {
  const { widthMode = 'composer', align = 'end' } = options
  const viewportHeight = window.innerHeight || 0
  const width = viewportWidth()
  const composerRect = composerOf(anchor)?.getBoundingClientRect() ?? null
  const anchorRect = anchor?.getBoundingClientRect() ?? null
  const safeTop = readSafeInset(SAFE_TOP_VAR)

  // Верхнюю границу панели задаёт кнопка: как `side="top"` у поппера размышлений.
  // Триггера ещё нет (ref не привязан) — панель прижимается к низу экрана:
  // лучше перекрыть тулбар, чем уехать за границу.
  const gap = triggerGap(anchorRect, composerRect)
  const low = anchorRect ? anchorRect.top - gap : viewportHeight - SHEET_GAP
  const top = safeTop + SHEET_GAP
  const room = Math.max(low - top, 0)
  // Места мало — показываем минимум (шапка + пара пунктов), но не выше экрана:
  // верхняя кромка панели не должна уйти в отрицательные координаты.
  const maxHeight = Math.min(Math.max(room, MIN_SHEET_HEIGHT), Math.max(low, 0))

  // `bottom` не округляем: округление сдвинуло бы зазор над кнопкой на ½px
  // относительно зазора под ней (CSS дробные px принимает).
  const bottom = Math.max(0, viewportHeight - low)
  const roundedMaxHeight = Math.round(maxHeight)

  // Потолок ширины — композер минус те же 2×8px, что и в режиме `'composer'`.
  const composerWidth = composerRect ? composerRect.width : width - 2 * SHEET_GAP
  const composerMaxWidth = Math.round(Math.max(composerWidth - 2 * SHEET_GAP, CONTENT_MIN_WIDTH))

  if (widthMode === 'content') {
    // Ширина по содержимому: отступ задаём только по одной стороне, вторую
    // оставляем `auto` — CSS считает ширину по содержимому (shrink-to-fit),
    // `min-width` держит минимум, `max-width` не даёт выйти за композер.
    if (align === 'start') {
      const anchorLeft = anchorRect ? anchorRect.left : readSafeInset(SAFE_LEFT_VAR)
      // Не помещается минимум справа — сдвигаем панель влево от кнопки, но не
      // уводим за левую кромку экрана (как `shift` у Radix).
      const left = Math.max(Math.min(anchorLeft, width - CONTENT_MIN_WIDTH - SHEET_GAP), 0)
      return {
        left: Math.round(left),
        right: null,
        bottom,
        maxHeight: roundedMaxHeight,
        maxWidth: Math.round(Math.min(composerMaxWidth, width - left - SHEET_GAP)),
      }
    }
    const anchorRight = anchorRect ? anchorRect.right : width - readSafeInset(SAFE_RIGHT_VAR)
    // Правый край панели — по правому краю кнопки; если слева от него не
    // помещается минимальная ширина, панель сдвигается вправо (Radix `shift`).
    const right = Math.max(Math.min(width - anchorRight, width - CONTENT_MIN_WIDTH - SHEET_GAP), 0)
    return {
      left: null,
      right: Math.round(right),
      bottom,
      maxHeight: roundedMaxHeight,
      maxWidth: Math.round(Math.min(composerMaxWidth, width - right - SHEET_GAP)),
    }
  }

  return {
    // Панель уже поля ввода: композер шире панели ровно на 2×8px.
    left: Math.round(
      (composerRect ? composerRect.left : readSafeInset(SAFE_LEFT_VAR)) + SHEET_GAP,
    ),
    right: Math.round(
      (composerRect ? width - composerRect.right : readSafeInset(SAFE_RIGHT_VAR)) + SHEET_GAP,
    ),
    // `bottom` — от низа viewport до нижней кромки панели (CSS `position: fixed`).
    bottom,
    maxHeight: roundedMaxHeight,
    maxWidth: null,
  }
}

/**
 * Снять фокус с активного элемента — вызывать на `pointerdown` по триггеру и при
 * открытии панели.
 *
 * На телефоне фокус в textarea держит экранную клавиатуру: если открыть панель
 * при поднятой клавиатуре, layout изменится уже после расчёта позиции. Blur
 * запускает скрытие клавиатуры **до** замера (программная подсказка браузеру без
 * хаков вроде скрытого input), а панель тем временем следит за кнопкой.
 */
export function blurActiveElement(): void {
  if (typeof document === 'undefined') return
  const active = document.activeElement
  if (active instanceof HTMLElement && typeof active.blur === 'function') active.blur()
}

/**
 * Следующий кадр. В jsdom/SSR `requestAnimationFrame` может отсутствовать —
 * тогда тот же шаг делаем таймером (поведение то же, точность ниже).
 */
function requestFrame(callback: () => void): number {
  if (typeof requestAnimationFrame === 'function') {
    return requestAnimationFrame(() => callback())
  }
  return setTimeout(callback, 16) as unknown as number
}

function cancelFrame(id: number): void {
  if (!id) return
  if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(id)
  else clearTimeout(id as unknown as ReturnType<typeof setTimeout>)
}

/** Геометрия значимо изменилась (сравнение по полям, а не по ссылке). */
function isSameGeometry(a: SheetGeometry, b: SheetGeometry): boolean {
  return (
    a.left === b.left &&
    a.right === b.right &&
    a.bottom === b.bottom &&
    a.maxHeight === b.maxHeight &&
    a.maxWidth === b.maxWidth
  )
}

/** Точка тапа попала в прямоугольник триггера (допуск на subpixel-округления). */
function isPointInsideAnchor(
  event: { clientX: number; clientY: number },
  anchor: HTMLElement,
): boolean {
  const rect = anchor.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return false
  return (
    event.clientX >= rect.left &&
    event.clientX <= rect.right &&
    event.clientY >= rect.top &&
    event.clientY <= rect.bottom
  )
}

interface SheetBodyProps {
  /** Шапка панели (поиск) — не скроллится вместе со списком. */
  header?: ReactNode
  /** Ref на скролл-контейнер списка (нужен виртуализатору). */
  scrollRef: RefObject<HTMLElement | null>
  /** Доп. классы скролл-контейнера (отступы пунктов). */
  scrollClassName?: string
  children: ReactNode
}

/**
 * Тело панели: шапка + скролл-контейнер + полоса прокрутки.
 *
 * Отдельный **мемоизированный** компонент, а не разметка внутри
 * `MobileMenuSheet`: панель ре-рендерится на каждый пересчёт геометрии
 * (ресайз окна/вьюпорта, скрытие клавиатуры, изменение высоты), и без границы
 * мемоизации в том же ре-рендере участвовало бы тело списка вместе с
 * виртуализатором, его `ResizeObserver` и полосой прокрутки — отсюда «мигание»
 * содержимого. Все пропсы стабильны (элемент `children` создаёт родитель, ref и
 * классы не меняются), поэтому при обновлении одной только геометрии `memo`
 * отсекает ре-рендер: строки списка остаются теми же DOM-узлами.
 *
 * Колбэк-ref стабилизирован (`useCallback`): иначе React на каждом рендере
 * отцеплял бы и прицеплял узел заново (`ref(null)` → `ref(node)`), и
 * `containerRef.current` на миг становился бы `null` — виртуализатор терял бы
 * скролл-элемент, а полоса прокрутки — метрики.
 */
const SheetBody = memo(function SheetBody({
  header,
  scrollRef,
  scrollClassName,
  children,
}: SheetBodyProps) {
  const setScrollElement = useCallback(
    (element: HTMLDivElement | null) => {
      scrollRef.current = element
    },
    [scrollRef],
  )

  return (
    <>
      {header}
      <div className="relative flex flex-col flex-1 min-h-0 w-full">
        <div
          ref={setScrollElement}
          data-testid="mobile-menu-sheet-scroll"
          className={`overlay-scrollbar-target flex-1 min-h-0 w-full overflow-y-auto overflow-x-hidden overscroll-contain${scrollClassName ? ` ${scrollClassName}` : ''}`}
        >
          {children}
        </div>
        {/* Список вертикальный (`overflow-x-hidden`) — горизонтальный ползунок
            не нужен и не должен мигать при пересчёте геометрии. */}
        <OverlayScrollbar
          containerRef={scrollRef}
          minThumbSize={24}
          hideDelayMs={1000}
          disableHorizontal
        />
      </div>
    </>
  )
})

export interface MobileMenuSheetProps {
  open: boolean
  onClose: () => void
  /**
   * Триггер панели: от его **верха** отсчитывается низ панели, от ближайшего
   * `.chat-composer` — ширина и зазор. Кнопка в рамке (как у размышлений) —
   * передавать рамку: панель встаёт над рамкой, а не над внутренней кнопкой.
   */
  anchorRef: RefObject<HTMLElement | null>
  /** Шапка панели (поиск) — не скроллится вместе со списком. */
  header?: ReactNode
  /** Подпись панели для скринридеров. */
  ariaLabel?: string
  /** Ref на скролл-контейнер списка (нужен виртуализатору). */
  scrollRef?: RefObject<HTMLElement | null>
  /** Доп. классы скролл-контейнера (отступы пунктов). */
  scrollClassName?: string
  /**
   * Ширина панели: `'composer'` (по умолчанию) — на всю ширину поля ввода,
   * `'content'` — по содержимому (минимум 140px), для компактных списков.
   */
  widthMode?: SheetWidthMode
  /** Выравнивание по кнопке в режиме `'content'` (по умолчанию — по правому краю). */
  align?: SheetAlign
  children: ReactNode
}

export function MobileMenuSheet({
  open,
  onClose,
  anchorRef,
  header,
  ariaLabel,
  scrollRef,
  scrollClassName,
  widthMode = 'composer',
  align = 'end',
  children,
}: MobileMenuSheetProps) {
  const [geometry, setGeometry] = useState<SheetGeometry | null>(null)
  const fallbackScrollRef = useRef<HTMLElement | null>(null)
  const listRef = scrollRef ?? fallbackScrollRef
  /**
   * Идёт «карантин открытия» — backdrop в это время не закрывает панель.
   * Ref, а не state: обработчик тапа не должен пересоздаваться (и не должен
   * вызывать ре-рендер панели), значение читается только в момент события.
   */
  const quarantineRef = useRef(false)

  // Позиция считается в layout-эффекте — до отрисовки кадра: панель не
  // появляется в «нулевом» месте и не прыгает следующим кадром.
  useLayoutEffect(() => {
    if (!open) {
      // Закрытая панель геометрию не хранит: при следующем открытии она
      // считается заново (за это время layout мог уехать вместе с клавиатурой).
      // Карантин снимается — следующий показ откроет его заново.
      quarantineRef.current = false
      setGeometry(null)
      return
    }

    /*
     * Карантин открытия: сразу после показа (и скрытия клавиатуры по `blur`)
     * Android повторяет тап по тем же координатам, а backdrop с первого кадра
     * лежит поверх кнопки — дребезг закрывал панель. Пока окно не истекло,
     * backdrop тапы игнорирует.
     */
    quarantineRef.current = true
    const quarantineId = setTimeout(() => {
      quarantineRef.current = false
    }, SHEET_OPEN_QUARANTINE_MS)

    // Клавиатура должна начать закрываться **до** первого замера.
    blurActiveElement()

    let disposed = false
    let followId = 0
    let remeasureId = 0
    let fallbackId: ReturnType<typeof setTimeout> | null = null
    const options: SheetGeometryOptions = { widthMode, align }

    /** Единственная точка обновления: `setState` — только при реальном изменении. */
    const apply = (): void => {
      const next = measureSheetGeometry(anchorRef.current, options)
      setGeometry((prev) => (prev && isSameGeometry(prev, next) ? prev : next))
    }

    /*
     * Догоняющая сверка через кадр: `resize` приходит **до** того, как приложение
     * переставило композер (React коммитит уже после обработчика), поэтому замер
     * в самом событии может быть на кадр устаревшим. Через два кадра layout
     * финальный — пересчитываем ещё раз (no-op, если не изменилось).
     */
    const scheduleRemeasure = (): void => {
      cancelFrame(remeasureId)
      remeasureId = requestFrame(() => {
        remeasureId = requestFrame(() => {
          remeasureId = 0
          if (!disposed) apply()
        })
      })
    }

    // Первый замер — до отрисовки кадра: панель видна сразу и уже на месте.
    apply()

    /*
     * Слежение за кнопкой: клавиатура гаснет 200–300 мс, композер вместе с
     * кнопкой едет вниз. Низ панели привязан к верху кнопки, поэтому панель
     * «едет» вместе с ней — покадровый пересчёт в течение `FOLLOW_TRIGGER_MS`,
     * дальше хватает событий.
     */
    const deadline = Date.now() + FOLLOW_TRIGGER_MS
    const follow = (): void => {
      followId = 0
      if (disposed) return
      apply()
      if (Date.now() < deadline) followId = requestFrame(follow)
    }
    followId = requestFrame(follow)

    // Страховка: первый замер мог попасть в промежуточный layout, а события не
    // прийти — тогда позицию добирает один отложенный замер. Не основной путь.
    fallbackId = setTimeout(apply, REVEAL_FALLBACK_MS)

    const update = (): void => scheduleRemeasure()
    const viewport = window.visualViewport
    window.addEventListener('resize', update)
    window.addEventListener('orientationchange', update)
    viewport?.addEventListener('resize', update)
    viewport?.addEventListener('scroll', update)
    // `scroll` документа (capture — ловит и вложенные контейнеры): композер может
    // уехать при прокрутке тулбара/страницы.
    document.addEventListener('scroll', update, true)
    return () => {
      disposed = true
      if (fallbackId !== null) {
        clearTimeout(fallbackId)
        fallbackId = null
      }
      clearTimeout(quarantineId)
      quarantineRef.current = false
      cancelFrame(followId)
      cancelFrame(remeasureId)
      followId = 0
      remeasureId = 0
      window.removeEventListener('resize', update)
      window.removeEventListener('orientationchange', update)
      viewport?.removeEventListener('resize', update)
      viewport?.removeEventListener('scroll', update)
      document.removeEventListener('scroll', update, true)
    }
  }, [open, anchorRef, widthMode, align])

  // Escape закрывает панель — как и Radix-дропдаун на десктопе.
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  if (!open || !geometry || typeof document === 'undefined') return null

  return createPortal(
    <>
      {/*
        Прозрачный слой перехвата (без затемнения): тап/клик вне панели закрывает
        её. Перехват намеренный — пока панель открыта, тап не должен попадать в
        композер/тулбар (иначе случайное нажатие уйдёт в поле ввода и снова
        поднимет клавиатуру). `preventDefault` на `pointerdown` гасит совместимые
        mouse-события.
      */}
      <div
        className="fixed inset-0 z-40"
        aria-hidden="true"
        data-testid="mobile-menu-sheet-backdrop"
        onPointerDown={(event) => {
          event.preventDefault()
          /*
           * Карантин открытия (`SHEET_OPEN_QUARANTINE_MS`): в первые ~380 мс
           * после показа панель тапами не закрывается вообще — ни «тап мимо», ни
           * тап по прямоугольнику кнопки. Именно сюда приходил повторный тап
           * Android после скрытия клавиатуры, и список агента пропадал.
           * `preventDefault` остаётся: тап не должен доходить до композера.
           */
          if (quarantineRef.current) return
          const anchor = anchorRef.current
          // Тап по прямоугольнику кнопки — это тап по триггеру (закрыть панель),
          // а не «тап мимо»: без пометки парный `click` открыл бы список заново.
          if (anchor && isPointInsideAnchor(event, anchor)) suppressNextTriggerClick()
          onClose()
        }}
      />
      <div
        role="menu"
        aria-label={ariaLabel}
        data-testid="mobile-menu-sheet"
        // Маркер проявления для тестов/отладки: панель видна с первого кадра,
        // ожидания стабилизации layout больше нет.
        data-revealed="true"
        // Маркер режима ширины: чем именно задана ширина, видно в отладке и тестах.
        data-width-mode={widthMode}
        className="z-50 flex flex-col overflow-hidden bg-popover text-popover-foreground rounded-xl ring-1 ring-foreground/10 shadow-lg"
        style={{
          // `position: fixed` инлайном, а не только классом: от него зависит сам
          // контракт панели (привязка к viewport, а не к скроллящейся странице).
          position: 'fixed',
          // `undefined` = `auto`: в режиме `'content'` ширину по содержимому
          // считает CSS (shrink-to-fit), отступ задан только с одной стороны.
          left: geometry.left ?? undefined,
          right: geometry.right ?? undefined,
          bottom: geometry.bottom,
          maxHeight: geometry.maxHeight,
          ...(geometry.maxWidth !== null ? { maxWidth: geometry.maxWidth } : {}),
          ...(widthMode === 'content' ? { minWidth: CONTENT_MIN_WIDTH } : {}),
        }}
      >
        {/* Тело списка — мемоизированная граница: обновление геометрии выше не
            перерисовывает строки, скролл-контейнер и полосу прокрутки. */}
        <SheetBody header={header} scrollRef={listRef} scrollClassName={scrollClassName}>
          {children}
        </SheetBody>
      </div>
    </>,
    document.body,
  )
}
