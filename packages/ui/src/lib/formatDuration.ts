/**
 * Форматирование обратного отсчёта (таймеры в шапках доков).
 *
 * Формат компактный: «мм:сс» (минуты всегда двузначные), а при часе и
 * больше — «ч:мм:сс». Значение не уходит в минус: истёкший отсчёт — «00:00».
 */

/**
 * Остаток времени в компактном виде.
 *
 * @param ms остаток в миллисекундах (отрицательное значение — как 0)
 */
export function formatRemaining(ms: number): string {
  // Нечисловое значение (битый срок) — как истёкший отсчёт.
  const totalSec = Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 1000)) : 0
  const hours = Math.floor(totalSec / 3600)
  const minutes = Math.floor((totalSec % 3600) / 60)
  const seconds = totalSec % 60
  const mm = String(minutes).padStart(2, '0')
  const ss = String(seconds).padStart(2, '0')
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`
}
