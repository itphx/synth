/**
 * Slug заголовка по алгоритму GitHub — чтобы якорные ссылки в оглавлениях,
 * написанных под GitHub, совпадали после локального рендера markdown.
 *
 * GitHub: нижний регистр, без HTML-тегов и пунктуации, пробелы → `-`.
 * Кириллица/Unicode-буквы сохраняются (`\p{L}`/`\p{N}` с флагом `u`).
 */

/** Slug для заголовка без букв/цифр (например, из одних символов пунктуации). */
export const FALLBACK_HEADING_SLUG = 'section'

/**
 * Текст заголовка → slug (без уникализации).
 *
 * Перегрузки не делаем: `text` — уже собранный текст токена (`token.text`),
 * markdown-разметка удаляется фильтром допустимых символов (`**` → пусто,
 * пробелы остаются), поэтому `**Жирный** пункт` → `жирный-пункт`.
 */
export function slugifyHeading(text: string): string {
  const slug = text
    .toLowerCase()
    // HTML-теги: в заголовке допустим инлайн-HTML (`<span>…</span>`).
    .replace(/<[^>]*>/g, '')
    // Только буквы/цифры/пробелы/`-`/`_`: пунктуация, эмодзи и markdown-маркеры уходят.
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    // Пробелы (в т.ч. переводы строк и табуляция) → дефис.
    .replace(/\s+/g, '-')
    // Повторные дефисы (в т.ч. полученные из нескольких пробелов) схлопываем.
    .replace(/-{2,}/g, '-')
    // Ведущие/хвостовые дефисы в якоре бессмысленны.
    .replace(/^-+|-+$/g, '')

  return slug || FALLBACK_HEADING_SLUG
}

/**
 * Уникализация slug'ов в пределах одного документа: повтор → `-1`, `-2`, …
 * (как у GitHub). Счётчик живёт в замыкании, поэтому создаётся **на документ**.
 */
export function createSlugger(): (text: string) => string {
  const used = new Set<string>()
  const nextSuffix = new Map<string, number>()

  return (text: string): string => {
    const base = slugifyHeading(text)
    let slug = base

    if (used.has(slug)) {
      let suffix = nextSuffix.get(base) ?? 1
      // Пропускаем уже занятые суффиксы: заголовок «a-1» не должен
      // столкнуться с уникализированным «a».
      while (used.has(`${base}-${suffix}`)) suffix += 1
      slug = `${base}-${suffix}`
      nextSuffix.set(base, suffix + 1)
    }

    used.add(slug)
    return slug
  }
}
