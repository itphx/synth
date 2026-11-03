/**
 * Чистая математика просмотра изображения (`ImageViewer`): масштаб и смещение
 * относительно центра видимой области. Вся арифметика живёт здесь — компонент
 * только применяет результат к `transform`.
 */

/** Масштаб и смещение изображения (пиксели от центра контейнера). */
export interface ZoomState {
  scale: number
  x: number
  y: number
}

/** Размеры содержимого (до масштабирования) и видимой области. */
export interface ZoomBounds {
  contentWidth: number
  contentHeight: number
  viewportWidth: number
  viewportHeight: number
}

/** Точка в координатах относительно центра видимой области. */
export interface ZoomPoint {
  x: number
  y: number
}

/** Минимальный масштаб — изображение вписано в контейнер. */
export const MIN_SCALE = 1
/** Максимальный масштаб просмотра. */
export const MAX_SCALE = 6

/** Исходное состояние: без увеличения и смещения. */
export const IDENTITY_ZOOM: ZoomState = { scale: MIN_SCALE, x: 0, y: 0 }

function finite(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback
}

/** Ограничение масштаба диапазоном `[MIN_SCALE, MAX_SCALE]`; `NaN` → `MIN_SCALE`. */
export function clampScale(scale: number): number {
  if (Number.isNaN(scale)) return MIN_SCALE
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale))
}

/** Предельное смещение по оси: половина разницы содержимого и окна. */
function limitOffset(contentSize: number, viewportSize: number, scale: number): number {
  const content = finite(contentSize)
  const viewport = finite(viewportSize)
  if (content <= 0 || viewport <= 0) return 0
  return Math.max(0, (content * clampScale(scale) - viewport) / 2)
}

/**
 * Ограничение смещения, чтобы изображение не уезжало за края: при
 * `scale === 1` смещение всегда 0, нулевые размеры (до layout/в jsdom) дают 0,
 * а не `NaN`.
 */
export function clampOffset(
  x: number,
  y: number,
  bounds: ZoomBounds,
  scale: number,
): ZoomState {
  const safeScale = clampScale(scale)
  if (safeScale <= MIN_SCALE) return { scale: MIN_SCALE, x: 0, y: 0 }
  const maxX = limitOffset(bounds.contentWidth, bounds.viewportWidth, safeScale)
  const maxY = limitOffset(bounds.contentHeight, bounds.viewportHeight, safeScale)
  const clampedX = Math.min(maxX, Math.max(-maxX, finite(x)))
  const clampedY = Math.min(maxY, Math.max(-maxY, finite(y)))
  return {
    scale: safeScale,
    // Нормализуем `-0`: он не должен утекать в состояние и строку `transform`.
    x: clampedX === 0 ? 0 : clampedX,
    y: clampedY === 0 ? 0 : clampedY,
  }
}

/**
 * Зум вокруг точки `anchor`: точка под якорем остаётся на месте
 * (`offset' = anchor - (anchor - offset) * (scale' / scale)`). Без `bounds`
 * смещение не ограничивается; результат никогда не содержит `NaN`.
 */
export function zoomAtPoint(
  state: ZoomState,
  factor: number,
  anchor: ZoomPoint,
  bounds?: ZoomBounds,
): ZoomState {
  const safeFactor = finite(factor, 1)
  if (safeFactor <= 0) return state
  const from = clampScale(state.scale)
  const scale = clampScale(from * safeFactor)
  if (scale === from) return { ...state, scale }
  const ratio = scale / from
  const x = finite(anchor.x) - (finite(anchor.x) - finite(state.x)) * ratio
  const y = finite(anchor.y) - (finite(anchor.y) - finite(state.y)) * ratio
  return bounds ? clampOffset(x, y, bounds, scale) : { scale, x, y }
}
