import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { marked, Renderer } from 'marked'
import DOMPurify from 'dompurify'
import { downloadBlob } from '@/lib/download'
import { i18nText, useI18nStore } from '@/lib/i18n'
import { codeFileName } from '@/lib/markdown/codeFile'
import { getThemeEpoch, highlightCode, subscribeThemeChange } from '@/lib/markdown/highlight'
import { rewriteRelativeAssets } from '@/lib/markdown/relativeAssets'
import { createSlugger } from '@/lib/markdown/slug'

interface MarkdownContentProps {
  content: string
  className?: string
  /** Трансформация HTML между marked.parser и DOMPurify.sanitize (например, подмена плейсхолдеров). */
  transformHtml?: (html: string) => string
  /**
   * Резолвер **относительного** `src`/`href`/`srcset` (`img.png`, `docs/a.md`)
   * в рабочий URL. Применяется пост-обработкой готового HTML
   * (`rewriteRelativeAssets`) — и к markdown, и к сырому HTML (`<picture>`).
   * `null` — оставить как есть; внешние ссылки, якоря и `/api/…` не передаются.
   * Принимающая сторона обязана мемоизировать (`useCallback`): резолвер входит
   * в зависимости использования HTML, иначе markdown пересобирается на каждый
   * рендер.
   */
  resolveAsset?: (target: string) => string | null
  /**
   * Идёт стриминг ответа: парсим отложенное значение (`useDeferredValue`), чтобы
   * не пересобирать весь markdown на каждой дельте. Финальный текст парсится полностью.
   */
  streaming?: boolean
}

/** Длиннее — номера строк отключаем (DOM не раздуваем, счётчик не нужен). */
export const MAX_NUMBERED_CODE_LINES = 1200

/** Разрешённые санитайзером теги: базовая разметка + обвязка кода/таблиц (renderer'ы ниже). */
export const MARKDOWN_ALLOWED_TAGS = [
  'p', 'br', 'strong', 'em', 'u', 's', 'del', 'code', 'pre',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'blockquote',
  'a', 'img', 'picture', 'source', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
  'span', 'div', 'hr',
  'input', 'label',
  'button', 'details', 'summary',
]

/** Разрешённые атрибуты (маркеры раскрытия/копирования/скачивания кода, target/rel ссылок). */
export const MARKDOWN_ALLOWED_ATTR = [
  'href', 'src', 'srcset', 'media', 'width', 'height',
  'alt', 'title', 'class', 'id', 'type', 'checked', 'disabled',
  'data-ph', 'data-lang', 'data-copy-code', 'data-numbered', 'data-copied',
  'data-download-code', 'data-downloaded', 'data-file-path',
  'target', 'rel', 'open', 'align',
]

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

/** Экранирование текста кода/языка перед вставкой в HTML (сырой HTML не проходит). */
function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] ?? ch)
}

/** ```ts title="x"``` → `ts`; пустой/отсутствующий язык → `text`. */
function normalizeLanguage(lang?: string): string {
  const first = (lang ?? '').trim().split(/\s+/)[0]
  return first ? first : 'text'
}

/** Язык для CSS-класса `language-…`: только безопасные символы. */
function languageClass(language: string): string {
  const safe = language.replace(/[^\w+#.-]/g, '')
  return safe || 'text'
}

/** Внешняя ссылка — только http(s) и protocol-relative; `#anchor` и относительные без target. */
function isExternalHref(href?: string): boolean {
  return typeof href === 'string' && /^(?:https?:)?\/\//i.test(href.trim())
}

/**
 * Найти цель якоря **внутри контейнера** (а не в документе): одно и то же
 * оглавление может быть отрисовано в чате и во вкладке файла — `document`
 * увезёт в чужой экземпляр. `CSS.escape` есть не везде (jsdom) — тогда
 * используем селектор по атрибуту с экранированием кавычек.
 */
function findAnchorTarget(container: HTMLElement, id: string): HTMLElement | null {
  const escape = typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape : null
  const selector = escape
    ? `#${escape(id)}`
    : `[id="${id.replace(/["\\]/g, '\\$&')}"]`
  try {
    return container.querySelector<HTMLElement>(selector)
  } catch {
    return null
  }
}

/**
 * Локальные renderer'ы marked: заголовок с `id` для якорных ссылок, язык,
 * копирование и скачивание у блоков кода, горизонтальный скролл у таблиц,
 * `target` у внешних ссылок, чип у инлайн-кода. Глобальный `marked.use` не
 * трогаем — инстанс рендерера живёт только здесь.
 *
 * Рендерер создаётся **на каждый разбор**: `createSlugger()` внутри держит
 * счётчик дубликатов заголовков, и он обязан сбрасываться на документ.
 */
function createMarkdownRenderer(): Renderer {
  const renderer = new Renderer()
  const renderTable = renderer.table.bind(renderer)
  const renderLink = renderer.link.bind(renderer)
  const nextSlug = createSlugger()

  renderer.heading = ({ tokens, depth, text }) => {
    // `marked` (v5+) сам `id` заголовкам не присваивает — без этого якорные
    // ссылки из оглавления никуда не ведут. Slug — по GitHub, из текста токена.
    const level = Math.min(6, Math.max(1, depth))
    const id = escapeHtml(nextSlug(text))
    // Инлайн-HTML заголовка (`**жирный**`, код, ссылки) рендерит парсер marked.
    const inline = renderer.parser.parseInline(tokens)
    return `<h${level} id="${id}">${inline}</h${level}>`
  }

  renderer.code = ({ text, lang }) => {
    const language = normalizeLanguage(lang)
    const lines = text.replace(/\n$/, '').split('\n')
    const numbered = lines.length <= MAX_NUMBERED_CODE_LINES
    const copyLabel = escapeHtml(i18nText('markdown.code.copy'))
    const downloadLabel = escapeHtml(i18nText('markdown.code.download'))
    // Строки — отдельными span'ами (номера рисует CSS-счётчик), между ними "\n",
    // чтобы `textContent` блока копировался с переносами.
    const body = lines.map((line) => `<span class="md-code-line">${escapeHtml(line)}</span>`).join('\n')
    return [
      `<div class="md-code" data-lang="${escapeHtml(language)}" data-numbered="${numbered ? 'true' : 'false'}">`,
      '<div class="md-code-head">',
      `<span class="md-code-lang">${escapeHtml(language)}</span>`,
      '<span class="md-code-actions">',
      // Кнопки — только иконки (CSS-маска, см. «Markdown в ответах» в index.css):
      // подпись остаётся в `aria-label`/`title`, текстового содержимого нет.
      `<button type="button" class="md-code-copy" data-copy-code aria-label="${copyLabel}" title="${copyLabel}"></button>`,
      `<button type="button" class="md-code-download" data-download-code aria-label="${downloadLabel}" title="${downloadLabel}"></button>`,
      '</span>',
      '</div>',
      `<pre class="md-code-pre"><code class="language-${escapeHtml(languageClass(language))}">${body}</code></pre>`,
      '</div>',
    ].join('')
  }

  renderer.table = (token) => `<div class="md-table-wrap">${renderTable(token)}</div>`

  renderer.image = ({ href, title, text }) => {
    // Относительные `src` резолвит пост-обработка HTML
    // (`rewriteRelativeAssets`) — она же покрывает сырой HTML и `srcset`.
    const src = href ?? ''
    const alt = escapeHtml(text ?? '')
    const titleAttr = title ? ` title="${escapeHtml(title)}"` : ''
    return `<img src="${escapeHtml(src)}" alt="${alt}"${titleAttr}>`
  }

  renderer.link = (token) => {
    // Относительные `href` → `data-file-path` (см. `rewriteRelativeAssets`):
    // marked отдаёт их как есть, решает пост-обработка.
    const html = renderLink(token)
    // marked возвращает чистый текст, если href не прошёл проверку — не трогаем.
    if (!isExternalHref(token.href) || !html.startsWith('<a ')) return html
    return `<a target="_blank" rel="noopener noreferrer" ${html.slice(3)}`
  }

  renderer.codespan = ({ text }) => `<code class="md-inline-code">${escapeHtml(text)}</code>`

  return renderer
}

/**
 * Подсветка «в полёте» по блоку кода: промисы переиспользуются между прогонами
 * эффекта. В StrictMode эффект монтируется дважды — второй прогон ждёт тот же
 * промис, а не начинает токенизацию заново и не пропускает блок навсегда.
 * Ключ — сам блок: пересозданный блок (новый `html`) получает свою подсветку.
 */
const pendingHighlights = new WeakMap<HTMLElement, Promise<string | null>>()

/**
 * Подпись кнопки-иконки: текстового содержимого у неё нет (иконка рисуется
 * CSS-маской), поэтому доступное имя и тултип — только в атрибутах.
 */
function setButtonLabel(button: HTMLButtonElement, key: string): void {
  const label = i18nText(key)
  button.setAttribute('aria-label', label)
  button.setAttribute('title', label)
}

/** Копирование в буфер: ошибки глушим — рендер не должен ломаться (нет API, отказ прав). */
async function writeClipboard(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value)
    return true
  } catch {
    return false
  }
}

export function MarkdownContent({
  content,
  className = '',
  transformHtml,
  resolveAsset,
  streaming = false,
}: MarkdownContentProps) {
  // Во время стрима показываем отложенный текст: React успевает пропускать
  // промежуточные дельты, парсится не каждый чанк. Финал (`streaming: false`) — полный.
  const deferredContent = useDeferredValue(content)
  const source = streaming ? deferredContent : content
  // Словарь в зависимостях: подписи кнопки копирования переводятся при смене локали.
  const dictionary = useI18nStore((s) => s.dictionary)
  /**
   * Epoch темы: растёт при каждой смене темы. Подсветка shiki пишет цвета
   * инлайном, поэтому уже подсвеченные блоки при смене темы надо перерисовать.
   */
  const themeEpoch = useSyncExternalStore(subscribeThemeChange, getThemeEpoch, getThemeEpoch)

  const html = useMemo(() => {
    if (!source) return ''
    try {
      const tokens = marked.lexer(source)
      // Рендерер — на каждый разбор: счётчик дубликатов заголовков (slugger)
      // должен начинаться с нуля для каждого документа.
      let raw = marked.parser(tokens, { renderer: createMarkdownRenderer() })
      if (transformHtml) raw = transformHtml(raw)
      // Относительные `src`/`href`/`srcset` (и markdown, и сырой HTML) —
      // до санитайзера: `data-file-path`/`srcset` должны попасть в allowlist.
      if (resolveAsset) raw = rewriteRelativeAssets(raw, resolveAsset)
      return DOMPurify.sanitize(raw, {
        ALLOWED_TAGS: MARKDOWN_ALLOWED_TAGS,
        ALLOWED_ATTR: MARKDOWN_ALLOWED_ATTR,
      })
    } catch (e) {
      console.warn('[MarkdownContent] marked failed, falling back to plain text:', e)
      return DOMPurify.sanitize(source)
    }
  }, [source, transformHtml, dictionary, resolveAsset])

  const timersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set())
  useEffect(() => {
    const timers = timersRef.current
    return () => {
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
    }
  }, [])

  const containerRef = useRef<HTMLDivElement | null>(null)

  /**
   * Объект для `dangerouslySetInnerHTML` должен быть **стабильным** между
   * рендерами: React 19 сравнивает пропсы по идентичности и пересоздаёт
   * `innerHTML` при каждом новом объекте — иначе любой ререндер чата стирал бы
   * разметку блоков кода (и применённую подсветку), а эффект, зависящий от
   * `html`, не перезапускался бы.
   */
  const htmlProp = useMemo(() => ({ __html: html }), [html])

  /**
   * Смена темы: подсвеченные блоки держат цвета **старой** темы (shiki пишет
   * их инлайном), поэтому при смене темы подсветку снимаем — блоки возвращаются
   * в исходное состояние (просто текстом: разметка shiki сохраняет текст, так
   * что `textContent` совпадает с оригиналом). Дальше эффект подсветки
   * (зависит от `themeEpoch`) рисует их заново, уже в новой палитре.
   *
   * Ref отличает «тема сменилась» от первого прогона эффекта: в StrictMode
   * эффекты выполняются дважды, и без ref'а второй прогон сбросил бы только
   * что начатую подсветку (и продублировал токенизацию).
   */
  const paintedThemeEpochRef = useRef(themeEpoch)
  useEffect(() => {
    if (paintedThemeEpochRef.current === themeEpoch) return
    paintedThemeEpochRef.current = themeEpoch
    const container = containerRef.current
    if (!container) return
    for (const block of Array.from(container.querySelectorAll<HTMLElement>('.md-code'))) {
      // Подсветка «в полёте»: промис от старой темы больше не актуален.
      delete block.dataset.highlighting
      pendingHighlights.delete(block)
      if (block.dataset.highlighted !== '1') continue
      delete block.dataset.highlighted
      const pre = block.querySelector<HTMLElement>('pre.md-code-pre')
      const code = pre?.querySelector('code')
      pre?.classList.remove('shiki')
      if (code) code.textContent = code.textContent ?? ''
    }
  }, [themeEpoch])

  /**
   * Подсветка кода (shiki, лениво) — только для «устоявшихся» блоков: во время
   * стриминга не трогаем (иначе DOM пересобирается на каждой дельте), а после
   * завершения шага (`streaming: false`) подсвечиваем один раз — маркер
   * `data-highlighted` не даёт повторять работу при перерисовках.
   *
   * Эффект устойчив к двойному монтированию (StrictMode): уже начатая
   * подсветка не отменяется cleanup'ом, а переиспользуется (тот же промис).
   * Результат применяется только если блок ещё в DOM и текст не изменился.
   */
  useEffect(() => {
    const container = containerRef.current
    if (!container || streaming) return
    const blocks = Array.from(container.querySelectorAll<HTMLElement>('.md-code[data-lang]'))
    for (const block of blocks) {
      const lang = block.dataset.lang ?? ''
      if (!lang || lang === 'text') continue
      if (block.dataset.highlighted === '1') continue
      const pre = block.querySelector<HTMLElement>('pre.md-code-pre')
      const code = pre?.querySelector('code')
      if (!pre || !code) continue
      const source = code.textContent ?? ''
      if (!source) continue
      // Уже начатая подсветка — ждём тот же промис (повторный прогон эффекта).
      if (pendingHighlights.has(block)) continue
      // Маркер «в полёте»: видно, что блок ждёт токенизацию.
      block.dataset.highlighting = '1'
      const pending = highlightCode(source, lang).catch(() => null)
      pendingHighlights.set(block, pending)
      void pending.then((highlighted) => {
        // Тема сменилась, пока шёл await — результат устарел, не применяем
        // (его перерисует следующий прогон эффекта, уже в новой палитре).
        if (getThemeEpoch() !== themeEpoch) return
        delete block.dataset.highlighting
        if (!highlighted) return
        // Блок уже подсвечен (повторный прогон) — ничего не делаем.
        if (block.dataset.highlighted === '1') return
        // Блок отсоединён (пересоздан/размонтирован) — результат не применяем.
        if (!block.isConnected) return
        // Контент изменился, пока шёл await — результат устарел, не применяем.
        if ((code.textContent ?? '') !== source) return
        code.innerHTML = highlighted
        pre.classList.add('shiki')
        block.dataset.highlighted = '1'
      })
    }
  }, [html, streaming, themeEpoch])

  // Делегирование клика: кнопки копирования и скачивания живут в HTML из marked,
  // не в React-дереве.
  const handleClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target
    if (!(target instanceof Element)) return

    // Якорная ссылка из оглавления: скроллим **внутри контейнера** и не пишем
    // hash в URL (в SPA без роутера он бесполезен и остаётся мусором).
    const anchor = target.closest<HTMLAnchorElement>('a[href^="#"]')
    if (anchor) {
      event.preventDefault()
      const rawId = (anchor.getAttribute('href') ?? '').slice(1)
      if (!rawId) return
      let id = rawId
      try {
        id = decodeURIComponent(rawId)
      } catch {
        // Битый процент (`#%`) — оставляем как есть, не бросаем.
      }
      const container = containerRef.current
      if (!container) return
      // Цель ищем только в своём документе: `document.getElementById` увёз бы
      // в другой отрендеренный экземпляр (чат vs вкладка файла).
      const heading = findAnchorTarget(container, id)
      // Цели нет — тихий no-op (не прыгаем в начало документа).
      if (!heading) return
      const reduceMotion =
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches
      heading.scrollIntoView({ block: 'start', behavior: reduceMotion ? 'auto' : 'smooth' })
      return
    }

    const copyButton = target.closest<HTMLButtonElement>('[data-copy-code]')
    if (copyButton) {
      const code = copyButton.closest('.md-code')?.querySelector('pre code')
      const text = code?.textContent?.replace(/\n+$/, '') ?? ''
      if (!text) return
      void writeClipboard(text).then((ok) => {
        if (!ok) return
        copyButton.dataset.copied = 'true'
        // `textContent` не трогаем — иначе пропадёт иконка (CSS-маска на ::before).
        setButtonLabel(copyButton, 'markdown.code.copied')
        const timer = setTimeout(() => {
          timersRef.current.delete(timer)
          if (!copyButton.isConnected) return
          delete copyButton.dataset.copied
          setButtonLabel(copyButton, 'markdown.code.copy')
        }, 1500)
        timersRef.current.add(timer)
      })
      return
    }

    const downloadButton = target.closest<HTMLButtonElement>('[data-download-code]')
    if (!downloadButton) return
    const block = downloadButton.closest('.md-code')
    const code = block?.querySelector('pre code')
    // Хвостовые переносы срезаем (как у копирования): файл не должен
    // заканчиваться лишней пустой строкой.
    const text = code?.textContent?.replace(/\n+$/, '') ?? ''
    if (!text) return
    const downloaded = downloadBlob(
      new Blob([text], { type: 'text/plain;charset=utf-8' }),
      codeFileName(block?.getAttribute('data-lang') ?? undefined),
    )
    if (!downloaded) return
    downloadButton.dataset.downloaded = 'true'
    // `textContent` не трогаем — иначе пропадёт иконка (CSS-маска на ::before).
    setButtonLabel(downloadButton, 'markdown.code.downloaded')
    const timer = setTimeout(() => {
      timersRef.current.delete(timer)
      if (!downloadButton.isConnected) return
      delete downloadButton.dataset.downloaded
      setButtonLabel(downloadButton, 'markdown.code.download')
    }, 1500)
    timersRef.current.add(timer)
  }, [])

  if (!html) {
    return null
  }

  return (
    <div
      className={`markdown-content text-sm leading-relaxed ${className}`}
      ref={containerRef}
      onClick={handleClick}
      dangerouslySetInnerHTML={htmlProp}
    />
  )
}
