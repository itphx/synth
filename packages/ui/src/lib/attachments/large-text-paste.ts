/**
 * Большой вставленный текст → файл-вложение.
 *
 * Вставка большого объёма текста в композер засоряет промпт и ломает его
 * читаемость. Вместо этого предлагаем отправить текст файлом — конвейер
 * вложений умеет уходить с обычным `.txt`.
 *
 * Модуль чистый: без React и без разбора горячих клавиш — только пороги и
 * сборка файла.
 */

/** Порог по числу символов. */
export const LARGE_TEXT_PASTE_CHAR_THRESHOLD = 2000

/** Порог по числу строк. */
export const LARGE_TEXT_PASTE_LINE_THRESHOLD = 25

function countLines(text: string): number {
  let lines = 1
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) lines += 1
  }
  return lines
}

/**
 * Стоит ли предлагать вставку как файл.
 *
 * Пороги объединены по «ИЛИ»: достаточно длинного текста или числа строк.
 * Пустой и пробельный текст — никогда.
 */
export function shouldOfferLargeTextPaste(text: string): boolean {
  if (!text || !text.trim()) return false
  if (text.length >= LARGE_TEXT_PASTE_CHAR_THRESHOLD) return true
  return countLines(text) >= LARGE_TEXT_PASTE_LINE_THRESHOLD
}

/**
 * Собирает вставленный текст в файл-вложение.
 *
 * Имя — `pasted-text-<ISO-метка времени>.txt`, чтобы вложения из разных
 * вставок различались.
 */
export function buildPastedTextFile(text: string, now: Date = new Date()): File {
  const name = `pasted-text-${now.toISOString()}.txt`
  return new File([text], name, {
    type: 'text/plain',
    lastModified: now.getTime(),
  })
}
