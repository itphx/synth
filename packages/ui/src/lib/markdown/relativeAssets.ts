/**
 * Относительные пути в Markdown (`![img](pictures/a.png)`, `[файл](docs/a.md)`).
 *
 * В чате база — origin приложения, а во вкладке файла проекта картинки/ссылки
 * должны резолвиться от каталога самого `.md` **внутри workspace**. Правила
 * нормализации — чистые функции (проверяются тестами); пост-обработка HTML
 * (`rewriteRelativeAssets`) работает через `DOMParser` и покрывает **и**
 * markdown-картинки, **и** сырой HTML (`<picture><source srcset=…>`).
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

/** Уже абсолютный адрес приложения (`/api/…`) — резолвить не нужно. */
function isAppAbsolute(target: string): boolean {
  return /^\/api(?:\/|$)/i.test(target.trim())
}

/**
 * Кандидаты `srcset` (`url [descriptor], …`) — переписать `url` каждого
 * относительного кандидата, сохранив дескрипторы (`1x`, `100w`). Разбор по
 * правилам `srcset`: URL — до пробела (внутренние запятые `data:`-URI
 * сохраняются), дескриптор — до запятой-разделителя.
 */
function rewriteSrcset(
  srcset: string,
  resolve: (target: string) => string | null,
): string {
  const isSpace = (ch: string) => /\s/.test(ch)
  const candidates: string[] = []
  let pos = 0

  while (pos < srcset.length) {
    // Пропускаем пробелы и запятые-разделители.
    while (pos < srcset.length && (isSpace(srcset[pos]!) || srcset[pos] === ',')) pos += 1
    if (pos >= srcset.length) break

    const urlStart = pos
    while (pos < srcset.length && !isSpace(srcset[pos]!)) pos += 1
    let url = srcset.slice(urlStart, pos)
    // Запятая в конце URL — разделитель кандидатов без дескриптора.
    const hasTrailingComma = url.endsWith(',')
    if (hasTrailingComma) url = url.replace(/,+$/, '')

    let descriptor = ''
    if (!hasTrailingComma) {
      const descriptorStart = pos
      while (pos < srcset.length && srcset[pos] !== ',') pos += 1
      descriptor = srcset.slice(descriptorStart, pos).trim()
      if (srcset[pos] === ',') pos += 1
    }

    const rewritten = url ? resolve(url) : null
    const target = rewritten ?? url
    if (!target) continue
    candidates.push(descriptor ? `${target} ${descriptor}` : target)
  }

  return candidates.join(', ')
}

/**
 * Пост-обработка готового HTML: относительные `src`/`href`/`srcset`
 * переписываются резолвером — **и для markdown-разметки, и для сырого HTML**
 * (`<picture><source srcset=…>`, `<img width=…>`). Абсолютные адреса
 * (`/api/…`), якоря (`#…`), protocol-relative (`//…`) и схемы (`http:`,
 * `data:`, `mailto:`) не трогаются.
 *
 * Ссылки на файлы становятся `href="#"` + `data-file-path` (относительный путь
 * из разметки): навигацию перехватывает принимающий компонент. `srcset`
 * сохраняет дескрипторы (`1x`/`100w`), `media`/`width`/`height`/`alt` — как есть.
 */
export function rewriteRelativeAssets(
  html: string,
  resolveAsset: (target: string) => string | null,
): string {
  if (!html) return html

  const doc = new DOMParser().parseFromString(html, 'text/html')
  const body = doc.body

  const resolve = (target?: string | null): string | null => {
    if (typeof target !== 'string') return null
    const value = target.trim()
    if (!value || isExternalOrAnchor(value) || isAppAbsolute(value)) return null
    return resolveAsset(value) || null
  }

  const rewriteElementSrcset = (element: Element): void => {
    const srcset = element.getAttribute('srcset')
    if (!srcset) return
    element.setAttribute('srcset', rewriteSrcset(srcset, resolve))
  }

  for (const image of Array.from(body.querySelectorAll('img'))) {
    const src = resolve(image.getAttribute('src'))
    if (src) image.setAttribute('src', src)
    rewriteElementSrcset(image)
  }

  for (const source of Array.from(body.querySelectorAll('source'))) {
    rewriteElementSrcset(source)
  }

  for (const link of Array.from(body.querySelectorAll('a[href]'))) {
    const href = link.getAttribute('href')?.trim()
    if (!href) continue
    const resolved = resolve(href)
    if (!resolved) continue
    // В `data-file-path` — путь из разметки (резолв делает принимающая сторона).
    link.setAttribute('href', '#')
    link.setAttribute('data-file-path', href)
  }

  return body.innerHTML
}
