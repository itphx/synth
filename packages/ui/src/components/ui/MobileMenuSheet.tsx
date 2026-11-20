import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { OverlayScrollbar } from './OverlayScrollbar'

/**
 * Мобильная панель списка (телефон/узкая колонка) — общая для селекторов
 * композера (модель, агент).
 *
 * Почему не Radix-поппер `side="top"`: поппер привязан к кнопке тулбара, а на
 * телефоне высота видимой области меняется уже **после** расчёта позиции
 * (клавиатура закрывается/открывается, layout «дышит»). Панель оказывалась над
 * полем ввода, «прыгала» под палец и верхними пунктами уходила за край экрана
 * (внутреннего скролла у поппера нет).
 *
 * Здесь панель — фиксированный лист в `document.body`, прижатый **нижней
 * кромкой к верху композера** (`.chat-composer` — ближайший предок триггера):
 * - `bottom = max(8px, innerHeight - composerTop)` — поле ввода остаётся видимым;
 * - `max-height = доступное место над композером (composerTop - safe-top - 16px)` —
 *   верх не выходит за экран, панель использует всю эту область (в пустой сессии
 *   композер по центру — список раскрывается на всю верхнюю половину), а при
 *   переполнении список скроллится **внутри** панели;
 * - позиция пересчитывается на `resize`, `orientationchange` и на
 *   `visualViewport` resize/scroll (слушатели снимаются на закрытии/unmount),
 *   поэтому панель следует за композером, а не «прыгает» сама по себе.
 *
 * Появление ждёт стабилизации layout. Триггер на `pointerdown` снимает фокус
 * (`blurActiveElement`), клавиатура начинает скрываться — но layout приходит в
 * себя ещё 200–300 мс. Замер сразу после открытия попадает в промежуточное
 * состояние (композер ещё поднят клавиатурой), и панель через мгновение уезжает
 * вниз на высоту клавиатуры — ровно под палец, которым уже выбрали пункт
 * Поэтому:
 * - клавиатура закрыта — панель видна сразу (десктопные сценарии не меняются);
 * - клавиатура открыта — панель рендерится скрытой (`visibility: hidden` +
 *   `pointer-events: none`; **не** `display: none`, иначе теряются замеры и
 *   виртуализатор) и проявляется, когда `visualViewport` вернулся к layout-окну
 *   (`resize` с `height >= innerHeight - 50`), либо по страховочному таймауту
 *   ~400 мс, если событие не придёт (iOS, десктопные эмуляции).
 */

/** Зазор панели до краёв экрана и до композера. */
const SHEET_GAP = 8
/** Минимальная высота панели: шапка поиска и пара пунктов. */
const MIN_SHEET_HEIGHT = 96
/** Минимальный зазор до верхней границы экрана не нужен — панель занимает всё место над композером. */

/**
 * Порог «клавиатура открыта»: видимая область ниже layout-окна больше чем на
 * 100px. Меньшая разница — адресная строка, зум и прочая мелочь, не клавиатура.
 */
const KEYBOARD_OPEN_DELTA = 100
/** Клавиатура закрылась: видимая область вернулась к layout-окну (±50px). */
const KEYBOARD_CLOSED_DELTA = 50
/** Страховка: событие стабилизации может не прийти — панель проявляется сама. */
const STABILIZE_TIMEOUT_MS = 400
/**
 * Предел ожидания стабилизации. Страховочный тик не показывает панель, пока
 * `visualViewport` всё ещё сжат (на медленном устройстве клавиатура уходит
 * дольше 400 мс), но и держать её скрытой бесконечно нельзя: дольше этого
 * предела показываем как есть — скрытая навсегда панель хуже неточной позиции.
 */
const STABILIZE_MAX_WAIT_MS = 800
/** Проявление панели: геометрия к этому моменту финальная, поэтому только прозрачность. */
const REVEAL_TRANSITION_MS = 120

const SAFE_TOP_VAR = '--synth-safe-area-top'
const SAFE_LEFT_VAR = '--synth-safe-area-left'
const SAFE_RIGHT_VAR = '--synth-safe-area-right'

export interface SheetGeometry {
  left: number
  right: number
  bottom: number
  maxHeight: number
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

/**
 * Геометрия панели по текущему положению композера.
 *
 * Экспортируется для тестов: чистая функция от `getBoundingClientRect` и
 * viewport, без подписки на события.
 */
export function measureSheetGeometry(anchor: HTMLElement | null): SheetGeometry {
  const viewportHeight = window.innerHeight || 0
  // Композера нет (нестандартное размещение селектора) — панель прижимается к
  // низу экрана: лучше перекрыть тулбар, чем уехать за границу.
  const composer = anchor?.closest('.chat-composer') as HTMLElement | null
  const composerTop = composer ? composer.getBoundingClientRect().top : viewportHeight
  const safeTop = readSafeInset(SAFE_TOP_VAR)
  // Место над композером с учётом safe-area: верхняя граница — safe-top + 8px.
  const available = composerTop - safeTop - SHEET_GAP * 2
  return {
    left: Math.round(readSafeInset(SAFE_LEFT_VAR) + SHEET_GAP),
    right: Math.round(readSafeInset(SAFE_RIGHT_VAR) + SHEET_GAP),
    // Композер за пределами экрана — 8px от низа, ближе к нему не прижимаемся.
    bottom: Math.round(Math.max(SHEET_GAP, viewportHeight - composerTop)),
    // Панель занимает ВСЁ место над композером (раскрывается «вверх и вниз» в
    // пределах видимой области): в пустой сессии композер стоит по центру, и
    // список использует верхнюю половину целиком, а не искусственные 70%.
    // Скролл появляется только при реальном переполнении.
    maxHeight: Math.round(Math.max(available, MIN_SHEET_HEIGHT)),
  }
}

/** Видимая область `visualViewport` (в jsdom/SSR API нет — считаем отсутствующей). */
function visualViewportHeight(): number | null {
  if (typeof window === 'undefined') return null
  const height = window.visualViewport?.height
  return typeof height === 'number' && Number.isFinite(height) ? height : null
}

/**
 * Открыта ли экранная клавиатура на момент открытия панели.
 *
 * Ориентир — `visualViewport`: при поднятой клавиатуре видимая область заметно
 * ниже layout-окна (`innerHeight`). Layout при этом ещё сжат, то есть замер
 * позиции сейчас даст промежуточную геометрию.
 */
export function isKeyboardOpen(): boolean {
  const height = visualViewportHeight()
  if (height === null) return false
  return height < (window.innerHeight || 0) - KEYBOARD_OPEN_DELTA
}

/**
 * Layout стабилизировался: видимая область вернулась к layout-окну, то есть
 * клавиатура закрылась и композер встал на своё место.
 */
export function isLayoutStable(): boolean {
  const height = visualViewportHeight()
  if (height === null) return true
  return height >= (window.innerHeight || 0) - KEYBOARD_CLOSED_DELTA
}

/** Геометрия значимо изменилась (сравнение по полям, а не по ссылке). */
function isSameGeometry(a: SheetGeometry, b: SheetGeometry): boolean {
  return a.left === b.left && a.right === b.right && a.bottom === b.bottom && a.maxHeight === b.maxHeight
}

/**
 * Снять фокус с активного элемента — вызывать на `pointerdown` по триггеру.
 *
 * На телефоне фокус в textarea держит экранную клавиатуру: если открыть панель
 * при поднятой клавиатуре, layout изменится уже после расчёта позиции. Blur
 * запускает скрытие клавиатуры **до** открытия и измерения, а панель ждёт
 * стабилизации layout перед показом.
 */
export function blurActiveElement(): void {
  if (typeof document === 'undefined') return
  const active = document.activeElement
  if (active instanceof HTMLElement && typeof active.blur === 'function') active.blur()
}

export interface MobileMenuSheetProps {
  open: boolean
  onClose: () => void
  /** Триггер панели: от него ищется ближайший `.chat-composer` — верх = низ панели. */
  anchorRef: RefObject<HTMLElement | null>
  /** Шапка панели (поиск) — не скроллится вместе со списком. */
  header?: ReactNode
  /** Подпись панели для скринридеров. */
  ariaLabel?: string
  /** Ref на скролл-контейнер списка (нужен виртуализатору). */
  scrollRef?: RefObject<HTMLElement | null>
  /** Доп. классы скролл-контейнера (отступы пунктов). */
  scrollClassName?: string
  children: ReactNode
}

interface SheetState {
  geometry: SheetGeometry
  /** Панель видна и принимает тапы: layout стабилизировался после скрытия клавиатуры. */
  revealed: boolean
}

export function MobileMenuSheet({
  open,
  onClose,
  anchorRef,
  header,
  ariaLabel,
  scrollRef,
  scrollClassName,
  children,
}: MobileMenuSheetProps) {
  const [sheet, setSheet] = useState<SheetState | null>(null)
  const fallbackScrollRef = useRef<HTMLElement | null>(null)
  const listRef = scrollRef ?? fallbackScrollRef

  // Позиция считается в layout-эффекте — до отрисовки кадра: панель не
  // появляется в «нулевом» месте и не прыгает следующим кадром.
  useLayoutEffect(() => {
    if (!open) {
      // Закрытая панель геометрию не хранит: при следующем открытии она
      // считается заново (за это время layout мог уехать вместе с клавиатурой).
      setSheet(null)
      return
    }

    // Пока клавиатура открыта, layout ещё промежуточный: панель рендерится, но
    // скрыта. Показ «как есть» показывал её в промежуточной позиции, а через
    // 200–300 мс сдвигал вниз на высоту клавиатуры.
    const hiddenByKeyboard = isKeyboardOpen()
    // Показ необратим: после проявления панель не скрывается повторно, даже
    // если прилетит «сжатый» resize (клавиатуру снова открыли) — иначе мигание.
    let visible = !hiddenByKeyboard

    let fallbackTimer: ReturnType<typeof setTimeout> | null = null
    const clearFallback = () => {
      if (fallbackTimer !== null) {
        clearTimeout(fallbackTimer)
        fallbackTimer = null
      }
    }

    /**
     * Единственная точка обновления: пересчёт геометрии и (при необходимости)
     * показ. `setState` — только при реальном изменении: иначе каждое событие
     * `visualViewport` давало бы лишний кадр и заметное «дрожание» панели.
     */
    const apply = (reveal: boolean) => {
      if (reveal) {
        visible = true
        clearFallback()
      }
      const revealed = visible
      const geometry = measureSheetGeometry(anchorRef.current)
      setSheet((prev) =>
        prev && prev.revealed === revealed && isSameGeometry(prev.geometry, geometry)
          ? prev
          : { geometry, revealed },
      )
    }

    /*
     * Догоняющая сверка через кадр. Событие `resize` приходит **до** того, как
     * приложение переставило композер (React коммитит уже после обработчика),
     * поэтому замер в самом событии может быть на кадр устаревшим: на живом
     * стенде панель оставалась висеть в 395px над композером. Через два кадра
     * layout финальный — пересчитываем ещё раз (no-op, если не изменилось).
     */
    let frame = 0
    let nextFrame = 0
    const cancelFrames = () => {
      if (typeof cancelAnimationFrame !== 'function') return
      if (frame) cancelAnimationFrame(frame)
      if (nextFrame) cancelAnimationFrame(nextFrame)
      frame = 0
      nextFrame = 0
    }
    const scheduleRemeasure = () => {
      if (typeof requestAnimationFrame !== 'function') return
      cancelFrames()
      frame = requestAnimationFrame(() => {
        nextFrame = requestAnimationFrame(() => apply(visible))
      })
    }

    // Первый замер — до отрисовки кадра.
    apply(visible)

    if (hiddenByKeyboard) {
      // Страховка: событие стабилизации может не прийти (iOS, десктопная
      // эмуляция) — тогда панель проявляется по таймеру, уже по текущему
      // (к этому времени финальному) layout. Пока `visualViewport` сжат,
      // показывать нельзя: панель встала бы в промежуточную позицию и уехала
      // бы вниз — ровно то, на что жаловался владелец.
      let waited = 0
      const armFallback = () => {
        fallbackTimer = setTimeout(() => {
          waited += STABILIZE_TIMEOUT_MS
          if (!isLayoutStable() && waited < STABILIZE_MAX_WAIT_MS) {
            armFallback()
            return
          }
          apply(true)
        }, STABILIZE_TIMEOUT_MS)
      }
      armFallback()
    }
    scheduleRemeasure()

    const update = () => {
      // Стабильность определяем по фактической видимой области, а не по типу
      // события: `visualViewport.resize`, `window.resize` и `orientationchange`
      // приходят в разном порядке и с разной полнотой (ADR-подобных гарантий у
      // браузеров нет).
      apply(isLayoutStable())
      scheduleRemeasure()
    }

    const viewport = window.visualViewport
    window.addEventListener('resize', update)
    window.addEventListener('orientationchange', update)
    viewport?.addEventListener('resize', update)
    viewport?.addEventListener('scroll', update)
    return () => {
      clearFallback()
      cancelFrames()
      window.removeEventListener('resize', update)
      window.removeEventListener('orientationchange', update)
      viewport?.removeEventListener('resize', update)
      viewport?.removeEventListener('scroll', update)
    }
  }, [open, anchorRef])

  // Escape закрывает панель — как и Radix-дропдаун на десктопе.
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  if (!open || !sheet || typeof document === 'undefined') return null

  const { geometry } = sheet

  return createPortal(
    <>
      {/*
        Прозрачный слой перехвата (без затемнения): тап/клик вне панели закрывает
        её. Перехват намеренный — пока панель открыта, тап не должен попадать в
        композер/тулбар (иначе случайное нажатие уйдёт в поле ввода и снова
        поднимет клавиатуру).
      */}
      <div
        className="fixed inset-0 z-40"
        aria-hidden="true"
        data-testid="mobile-menu-sheet-backdrop"
        onPointerDown={onClose}
      />
      <div
        role="menu"
        aria-label={ariaLabel}
        data-testid="mobile-menu-sheet"
        // Маркер стабилизации для тестов и отладки: `false` — панель ещё ждёт
        // layout и не принимает тапы.
        data-revealed={sheet.revealed ? 'true' : 'false'}
        className="z-50 flex flex-col overflow-hidden bg-popover text-popover-foreground rounded-xl ring-1 ring-foreground/10 shadow-lg"
        style={{
          // `position: fixed` инлайном, а не только классом: от него зависит сам
          // контракт панели (привязка к viewport, а не к скроллящейся странице).
          position: 'fixed',
          left: geometry.left,
          right: geometry.right,
          bottom: geometry.bottom,
          maxHeight: geometry.maxHeight,
          // Скрытие — `visibility`, а не `display: none`: геометрия и замеры
          // виртуализатора продолжают работать, но панель не видна и не ловит
          // тапы. К моменту проявления геометрия уже финальная и не меняется,
          // поэтому анимируется только прозрачность.
          visibility: sheet.revealed ? 'visible' : 'hidden',
          pointerEvents: sheet.revealed ? 'auto' : 'none',
          opacity: sheet.revealed ? 1 : 0,
          transition: `opacity ${REVEAL_TRANSITION_MS}ms ease-out`,
        }}
      >
        {header}
        <div className="relative flex flex-col flex-1 min-h-0 w-full">
          <div
            ref={(element) => {
              listRef.current = element
            }}
            data-testid="mobile-menu-sheet-scroll"
            className={`overlay-scrollbar-target flex-1 min-h-0 w-full overflow-y-auto overflow-x-hidden overscroll-contain${scrollClassName ? ` ${scrollClassName}` : ''}`}
          >
            {children}
          </div>
          <OverlayScrollbar containerRef={listRef} minThumbSize={24} hideDelayMs={1000} />
        </div>
      </div>
    </>,
    document.body,
  )
}
