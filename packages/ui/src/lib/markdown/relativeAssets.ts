/**
 * Относительные пути в Markdown (`![img](pictures/a.png)`, `[файл](docs/a.md)`).
 *
 * В чате база — origin приложения, а во вкладке файла проекта картинки/ссылки
 * должны резолвиться от каталога самого `.md` **внутри workspace**. Модуль
 * чистый (без DOM и React), чтобы правила нормализации проверялись тестами.
 *
 * Безопасность: выход выше корня workspace (`../../x`) не нормализуется, а
 * отбрасывается (`null`) — наружу рабочего каталога мы не подставляем.
 */

/** Схема URL (`https:`, `mailto:`, `data:`, `tel:`, …). */
const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i

/**
 * Цель не относительная: якорь (`#…`), protocol-relative (`//host/…`) или
 * абсолютный URL со схемой. Такие `src`/`href` не резолвим.
 */
export function isExternalOrAnchor(target: string): boolean {
  const value = target.trim()
  if (!value) return true
  if (value.startsWith('#')) return true
  if (value.startsWith('//')) return true
  return URL_SCHEME_RE.test(value)
}

/** Путь файла → `{ dir, name }` (`docs/a.md` → `docs` + `a.md`). */
export function splitFilePath(path: string): { dir: string; name: string } {
  const normalized = path.replace(/\\/g, '/')
  const index = normalized.lastIndexOf('/')
  if (index < 0) return { dir: '', name: normalized }
  return { dir: normalized.slice(0, index), name: normalized.slice(index + 1) }
}

/** `%`-декодирование для нормализации; битый процент оставляем как есть. */
function decodePath(path: string): string {
  try {
    return decodeURIComponent(path)
  } catch {
    return path
  }
}

/**
 * Относительная цель → путь внутри workspace (или `null`).
 *
 * - `baseDir` — каталог документа относительно корня workspace (`''` — корень);
 * - query/hash (`?…`, `#…`) отбрасываются;
 * - ведущий `/` — корень workspace, иначе база — `baseDir`;
 * - `./` и `../` нормализуются; выход выше корня → `null`;
 * - `%`-декодирование — только для сравнения/нормализации: результат — обычный
 *   (декодированный) путь, повторное кодирование делает `URLSearchParams` при
 *   построении URL (`rawFileUrl`);
 * - обратные слэши трактуются как разделители (markdown с Windows-путями).
 */
export function resolveRelativePath(baseDir: string, target: string): string | null {
  if (isExternalOrAnchor(target)) return null

  let path = target.trim().replace(/\\/g, '/')
  const cut = path.search(/[?#]/)
  if (cut >= 0) path = path.slice(0, cut)
  if (!path) return null

  const absolute = path.startsWith('/')
  // Декодируем до разбиения: `%2F`/`%5C` не должны прятать границу сегмента
  // (иначе `..%2F..` прошёл бы мимо нормализации).
  path = decodePath(path)

  const segments: string[] = absolute ? [] : decodePath(baseDir).split('/').filter(Boolean)
  // `baseDir` тоже проходит нормализацию: каталог выше корня недопустим.
  const base: string[] = []
  for (const segment of segments) {
    if (segment === '.') continue
    if (segment === '..') {
      if (base.length === 0) return null
      base.pop()
      continue
    }
    base.push(segment)
  }

  for (const segment of path.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (base.length === 0) return null
      base.pop()
      continue
    }
    base.push(segment)
  }

  if (base.length === 0) return null
  return base.join('/')
}
