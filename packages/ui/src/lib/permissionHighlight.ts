/**
 * Подсветка «виновника» в тексте запроса подтверждения прав.
 *
 * Механизм — тот же, что у `@`-упоминаний агентов
 * (`components/chat/SecretPlaceholder.tsx`, `splitMentions`/`renderMentions`):
 * текст разбивается на сегменты, нужный фрагмент оборачивается в `<span>`
 * с классом. Без `dangerouslySetInnerHTML` и без `<mark>`.
 */

export interface HighlightSegment {
  type: 'text' | 'hit'
  value: string
}

export interface HighlightRange {
  start: number
  end: number
}

/** Символ, которым слово может продолжаться (граница для basename). */
const WORD_CHAR = /[\p{L}\p{N}_-]/u

function isWordChar(char: string | undefined): boolean {
  return char !== undefined && WORD_CHAR.test(char)
}

/**
 * Найти токен-виновник в тексте.
 *
 * Порядок поиска:
 * 1. **точное вхождение** — токен как есть;
 * 2. **basename** — последний сегмент пути (`/home/u/.ssh/config` → `config`):
 *    путь мог быть нормализован в абсолютный, а в команде — относительный;
 * 3. **суффикс** — хвост пути из двух и более сегментов (`.ssh/config`).
 *
 * Basename ищется с проверкой границ, чтобы не попасть в середину слова
 * (`config` в `configuration`).
 */
export function findTokenRange(text: string, token: string): HighlightRange | null {
  const trimmed = token.trim()
  if (!trimmed || !text) return null

  const exact = text.indexOf(trimmed)
  if (exact >= 0) return { start: exact, end: exact + trimmed.length }

  const segments = trimmed.split(/[/\\]/).filter(Boolean)
  const base = segments[segments.length - 1]
  if (base && base !== trimmed) {
    let from = 0
    for (;;) {
      const idx = text.indexOf(base, from)
      if (idx < 0) break
      const before = idx > 0 ? text[idx - 1] : undefined
      const after = text[idx + base.length]
      if (!isWordChar(before) && !isWordChar(after)) {
        return { start: idx, end: idx + base.length }
      }
      from = idx + 1
    }
  }

  for (let take = 2; take < segments.length; take++) {
    const suffix = segments.slice(segments.length - take).join('/')
    const idx = text.indexOf(suffix)
    if (idx >= 0) return { start: idx, end: idx + suffix.length }
  }

  return null
}

/**
 * Разбить текст на сегменты «обычный текст» / «вхождение токена».
 *
 * Токен не найден — возвращаем текст одним сегментом (пустого блока не будет).
 */
export function splitTokenSegments(text: string, token: string): HighlightSegment[] {
  const range = findTokenRange(text, token)
  if (!range) return [{ type: 'text', value: text }]

  const segments: HighlightSegment[] = []
  if (range.start > 0) segments.push({ type: 'text', value: text.slice(0, range.start) })
  segments.push({ type: 'hit', value: text.slice(range.start, range.end) })
  if (range.end < text.length) segments.push({ type: 'text', value: text.slice(range.end) })
  return segments
}
