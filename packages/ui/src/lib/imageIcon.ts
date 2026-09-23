/**
 * Работа с иконками-провайдерами, которые хранятся прямо в JSON провайдера.
 *
 * Бэкенд `POST /api/v2/providers/fetch-icon` отдаёт сырой data-URL (иногда
 * 512×512 PNG на десятки КБ). Такие иконки едут в каждом `GET /api/v2/providers`,
 * поэтому перед сохранением сжимаем их в браузере (canvas) до маленького PNG.
 */

/** Порог: data-URL длиннее — считаем «тяжёлой» иконкой (провайдер хранит её в JSON). */
export const MAX_STORED_ICON_LENGTH = 8192

/** true, если значение — data-URL картинки длиннее лимита (остальные форматы не трогаем). */
export function isOversizedIcon(value: string | null | undefined, limit = MAX_STORED_ICON_LENGTH): boolean {
  return typeof value === 'string' && value.startsWith('data:image/') && value.length > limit
}

/** Декодирует data-URL: сначала через createImageBitmap, при недоступности — через <img>. */
async function decodeImage(dataUrl: string): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === 'function') {
    try {
      const blob = await (await fetch(dataUrl)).blob()
      return await createImageBitmap(blob)
    } catch {
      // createImageBitmap/fetch недоступны или не поняли data-URL — пробуем <img>
    }
  }
  const img = document.createElement('img')
  img.src = dataUrl
  await img.decode()
  return img
}

/**
 * Сжимает data-URL картинки до квадрата `size` (по умолчанию 64) в PNG.
 *  - не data:image/* или уже короче лимита → возвращает вход как есть (без работы);
 *  - декодирует через createImageBitmap (fallback: HTMLImageElement + decode());
 *  - вписывает с сохранением пропорций в квадрат size×size, фон прозрачный;
 *  - при любой ошибке/недоступности canvas или если результат НЕ короче входа → возвращает вход;
 *  - безопасно в SSR/jsdom (никакого доступа к DOM на верхнем уровне, всё в try/catch).
 */
export async function downscaleIconDataUrl(dataUrl: string, size = 64): Promise<string> {
  try {
    if (!isOversizedIcon(dataUrl)) return dataUrl
    if (typeof document === 'undefined') return dataUrl

    const source = await decodeImage(dataUrl)
    try {
      const width = source.width
      const height = source.height
      if (!width || !height) return dataUrl

      const canvas = document.createElement('canvas')
      canvas.width = size
      canvas.height = size
      const ctx = canvas.getContext('2d')
      if (!ctx) return dataUrl

      // contain: вписываем с сохранением пропорций, центрируем, фон остаётся прозрачным
      const scale = Math.min(size / width, size / height)
      const drawWidth = width * scale
      const drawHeight = height * scale
      ctx.clearRect(0, 0, size, size)
      ctx.drawImage(source, (size - drawWidth) / 2, (size - drawHeight) / 2, drawWidth, drawHeight)

      const result = canvas.toDataURL('image/png')
      return result && result.length < dataUrl.length ? result : dataUrl
    } finally {
      if (typeof ImageBitmap !== 'undefined' && source instanceof ImageBitmap) source.close()
    }
  } catch {
    return dataUrl
  }
}
