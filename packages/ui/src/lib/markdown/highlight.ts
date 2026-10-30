/**
 * Подсветка синтаксиса блоков кода markdown — shiki, **лениво**.
 *
 * Модуль ничего не тянет в основной бандл: `shiki/core`, движок oniguruma,
 * wasm и грамматики подключаются динамическим `import()` внутри функций,
 * поэтому в главный чанк попадает только этот файл (и он сам лежит в ленивом
 * чанке первого блока кода).
 *
 * Тема собирается из CSS-переменных темы Synth (`--background`,
 * `--foreground`, `--muted-foreground`, `--primary`, `--status-*`,
 * `--border`), поэтому светлая/тёмная тема и кастомные палитры работают без
 * отдельных наборов shiki. Тип темы (`light`/`dark`) — по светлоте фона.
 *
 * Любая проблема (неизвестный язык, слишком большой блок, ошибка shiki) даёт
 * `null` — блок кода остаётся как есть (экранированный текст), рендер не падает.
 */
import type { HighlighterCore, LanguageInput, ThemeRegistration } from 'shiki/core'

/** Больше строк — без подсветки (дорого токенизировать, читаемость важнее). */
export const MAX_HIGHLIGHT_LINES = 1200

/** Больше символов (~200 КБ) — без подсветки. */
export const MAX_HIGHLIGHT_CHARS = 200 * 1024

/** Предел кэша: при переполнении сбрасываем целиком (простая политика). */
const CACHE_LIMIT = 200

/** Имя темы в реестре shiki строится из отпечатка цветов: `synth-<hash>`. */
const THEME_PREFIX = 'synth'

interface LanguageSpec {
  /** Ленивый загрузчик грамматики (`shiki/langs/*.mjs`). */
  load: () => Promise<LanguageInput>
  /** Дополнительные имена в fence (алиасы shiki/GFM). */
  aliases: readonly string[]
}

/**
 * Единственное место со списком поддерживаемых языков.
 * Ключ — каноническое имя грамматики shiki, `aliases` — то, что пишут в fence.
 */
const LANGUAGES: Record<string, LanguageSpec> = {
  typescript: { load: () => import('shiki/langs/typescript.mjs'), aliases: ['ts', 'mts', 'cts'] },
  tsx: { load: () => import('shiki/langs/tsx.mjs'), aliases: [] },
  javascript: { load: () => import('shiki/langs/javascript.mjs'), aliases: ['js', 'mjs', 'cjs'] },
  jsx: { load: () => import('shiki/langs/jsx.mjs'), aliases: [] },
  json: { load: () => import('shiki/langs/json.mjs'), aliases: ['jsonc', 'json5'] },
  bash: { load: () => import('shiki/langs/bash.mjs'), aliases: ['sh', 'shell', 'shellscript', 'zsh', 'console'] },
  python: { load: () => import('shiki/langs/python.mjs'), aliases: ['py'] },
  yaml: { load: () => import('shiki/langs/yaml.mjs'), aliases: ['yml'] },
  sql: { load: () => import('shiki/langs/sql.mjs'), aliases: [] },
  diff: { load: () => import('shiki/langs/diff.mjs'), aliases: ['patch'] },
  html: { load: () => import('shiki/langs/html.mjs'), aliases: ['htm', 'xhtml', 'xml'] },
  css: { load: () => import('shiki/langs/css.mjs'), aliases: ['scss', 'less'] },
  markdown: { load: () => import('shiki/langs/markdown.mjs'), aliases: ['md', 'mdx'] },
}

/** Развёрнутая карта «имя из fence → канонический язык». */
const LANGUAGE_BY_NAME: Map<string, string> = (() => {
  const map = new Map<string, string>()
  for (const [name, spec] of Object.entries(LANGUAGES)) {
    map.set(name, name)
    for (const alias of spec.aliases) map.set(alias, name)
  }
  return map
})()

/**
 * Каноническое имя языка для fence или `null`, если язык не поддерживаем.
 * Неизвестный язык — это норма (```text, ```mermaid, …): подсветки просто нет.
 */
export function resolveHighlightLanguage(lang: string): string | null {
  const name = (lang ?? '').trim().toLowerCase().split(/\s+/)[0]
  if (!name) return null
  return LANGUAGE_BY_NAME.get(name) ?? null
}

/** Цвета темы Synth, прочитанные из CSS-переменных. */
interface ThemePalette {
  background: string
  foreground: string
  comment: string
  keyword: string
  string: string
  number: string
  entity: string
  tag: string
  invalid: string
}

interface SynthTheme {
  /** Имя темы в реестре shiki. */
  name: string
  /** Отпечаток палитры: изменился → кэш подсветки сбрасывается. */
  signature: string
  registration: ThemeRegistration
}

/** Запасная палитра, если CSS-переменные недоступны (SSR/тесты/до загрузки темы). */
const FALLBACK_DARK: ThemePalette = {
  background: '#151313',
  foreground: '#cdccc3',
  comment: '#8c8a80',
  keyword: '#edb449',
  string: '#81af6c',
  number: '#c2974d',
  entity: '#5aa9d9',
  tag: '#d8886d',
  invalid: '#d98678',
}

const FALLBACK_LIGHT: ThemePalette = {
  background: '#f7f3ea',
  foreground: '#3b2f26',
  comment: '#7a6a58',
  keyword: '#c2661d',
  string: '#3f7a4a',
  number: '#8a5a00',
  entity: '#1f6f8b',
  tag: '#a4503a',
  invalid: '#9c2f1f',
}

/** Значение CSS-переменной с `documentElement` (пустая строка, если недоступно). */
function readCssVar(name: string): string {
  if (typeof document === 'undefined') return ''
  try {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  } catch {
    return ''
  }
}

/** Тёмный ли корень документа (класс темы `.dark` либо `data-theme`). */
function isDarkDocument(): boolean {
  if (typeof document === 'undefined') return true
  const root = document.documentElement
  if (root.classList.contains('dark')) return true
  const attr = root.getAttribute('data-theme')
  return attr === 'dark' || attr === 'dark-theme'
}

const NUMBER_PATTERN = /^-?\d*\.?\d+$/

/** Светлый ли цвет: понимаем hex/rgb/hsl и okL* (в проекте темы — `oklch`). */
function isLightColor(color: string): boolean {
  const value = color.trim().toLowerCase()
  if (!value) return false

  const hex = /^#([0-9a-f]{3,8})$/.exec(value)
  if (hex) {
    const digits = hex[1]!
    const expand = digits.length <= 4 ? digits.slice(0, 3).split('').map((c) => c + c).join('') : digits.slice(0, 6)
    const r = parseInt(expand.slice(0, 2), 16)
    const g = parseInt(expand.slice(2, 4), 16)
    const b = parseInt(expand.slice(4, 6), 16)
    if ([r, g, b].some((n) => Number.isNaN(n))) return false
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.6
  }

  const rgb = /^rgba?\(([^)]+)\)$/.exec(value)
  if (rgb) {
    const parts = rgb[1]!.split(/[\s,/]+/).filter(Boolean).slice(0, 3)
    const [r, g, b] = parts.map((p) => (p.endsWith('%') ? (parseFloat(p) / 100) * 255 : parseFloat(p)))
    if (r === undefined || g === undefined || b === undefined || [r, g, b].some((n) => Number.isNaN(n))) return false
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.6
  }

  // okLch/okLab/Lch/Lab: первый параметр — светлота (0..1 или проценты).
  const lab = /^(?:oklch|oklab|lch|lab)\(([^)]+)\)$/.exec(value)
  if (lab) {
    const first = lab[1]!.split(/[\s,/]+/).filter(Boolean)[0] ?? ''
    const lightness = first.endsWith('%') ? parseFloat(first) / 100 : parseFloat(first)
    if (Number.isNaN(lightness)) return false
    return lightness > 0.6
  }

  const hsl = /^hsla?\(([^)]+)\)$/.exec(value)
  if (hsl) {
    const parts = hsl[1]!.split(/[\s,/]+/).filter(Boolean)
    const third = parts[2] ?? parts[1] ?? ''
    const lightness = third.endsWith('%') ? parseFloat(third) / 100 : parseFloat(third)
    if (Number.isNaN(lightness)) return false
    return lightness > 0.6
  }

  if (NUMBER_PATTERN.test(value)) return false
  // Неизвестный формат — считаем тёмным (дефолтная тема продукта тёмная).
  return false
}

/** Короткий FNV-1a хеш — для стабильного имени темы по палитре. */
function hashSignature(signature: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < signature.length; i += 1) {
    hash ^= signature.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(36)
}

/** Палитра из CSS-переменных: фон/текст/комментарии/ключевые слова/строки/… */
function readPalette(): ThemePalette {
  const fallback = isDarkDocument() ? FALLBACK_DARK : FALLBACK_LIGHT
  const pick = (name: string, backup: string): string => readCssVar(name) || backup
  return {
    background: pick('--background', fallback.background),
    foreground: pick('--foreground', fallback.foreground),
    comment: pick('--muted-foreground', fallback.comment),
    keyword: pick('--primary', fallback.keyword),
    string: pick('--status-success', fallback.string),
    number: pick('--status-warning', fallback.number),
    entity: pick('--status-info', fallback.entity),
    tag: pick('--chart-4', fallback.tag),
    invalid: pick('--destructive', fallback.invalid),
  }
}

/** TextMate-тема Synth из палитры (правила — от общего к частному). */
function buildTheme(): SynthTheme {
  const palette = readPalette()
  const type: 'light' | 'dark' = isLightColor(palette.background) ? 'light' : 'dark'
  const signature = [type, ...Object.values(palette)].join('|')
  const name = `${THEME_PREFIX}-${hashSignature(signature)}`

  const registration: ThemeRegistration = {
    name,
    displayName: 'Synth',
    type,
    settings: [
      { settings: { foreground: palette.foreground } },
      {
        scope: ['comment', 'punctuation.definition.comment', 'string.comment'],
        settings: { foreground: palette.comment, fontStyle: 'italic' },
      },
      {
        scope: [
          'keyword',
          'keyword.control',
          'keyword.operator.new',
          'keyword.other',
          'storage',
          'storage.type',
          'storage.modifier',
          'variable.language',
        ],
        settings: { foreground: palette.keyword },
      },
      {
        scope: ['string', 'string.quoted', 'string.template', 'constant.other.symbol', 'markup.inline.raw'],
        settings: { foreground: palette.string },
      },
      {
        scope: ['constant.numeric', 'constant.language', 'constant.character', 'keyword.other.unit'],
        settings: { foreground: palette.number },
      },
      {
        scope: [
          'entity.name.function',
          'support.function',
          'variable.function',
          'meta.function-call',
          'entity.name.type',
          'entity.name.class',
          'support.type',
          'support.class',
        ],
        settings: { foreground: palette.entity },
      },
      {
        scope: ['entity.name.tag', 'support.class.component', 'meta.tag', 'entity.other.attribute-name'],
        settings: { foreground: palette.tag },
      },
      {
        scope: ['invalid', 'invalid.illegal'],
        settings: { foreground: palette.invalid },
      },
      {
        scope: ['keyword.operator', 'punctuation', 'meta.brace', 'punctuation.separator'],
        settings: { foreground: palette.foreground },
      },
    ],
  }

  return { name, signature, registration }
}

/** Кэш HTML по `${lang}\0${code}`; сбрасывается при смене темы/переполнении. */
const cache = new Map<string, string>()
/** Отпечаток палитры, для которой собран текущий кэш. */
let cachedThemeSignature: string | null = null
/** Singleton highlighter: создаётся при первом вызове, не при импорте. */
let highlighterPromise: Promise<HighlighterCore> | null = null
/** Дедуп параллельных загрузок грамматик. */
const languageLoads = new Map<string, Promise<void>>()
/** Дедуп параллельных загрузок тем. */
const themeLoads = new Map<string, Promise<void>>()

/** Сброс кэша HTML (смена темы, тесты). */
export function clearHighlightCache(): void {
  cache.clear()
  cachedThemeSignature = null
}

/** Текущая тема по CSS-переменным (палитра дешёвая, но не кэшируется вслепую). */
function currentTheme(): SynthTheme {
  const theme = buildTheme()
  if (cachedThemeSignature !== null && cachedThemeSignature !== theme.signature) {
    // Цвета в инлайновых стилях — старый кэш отдавал бы устаревшую палитру.
    cache.clear()
  }
  cachedThemeSignature = theme.signature
  return theme
}

/** Создание высокоуровневого инстанса shiki (ядро + wasm + движок). */
async function createHighlighter(theme: SynthTheme): Promise<HighlighterCore> {
  const [{ createHighlighterCore }, { createOnigurumaEngine }] = await Promise.all([
    import('shiki/core'),
    import('shiki/engine/oniguruma'),
  ])
  return createHighlighterCore({
    themes: [theme.registration],
    langs: [],
    engine: createOnigurumaEngine(() => import('shiki/wasm')),
  })
}

/** Singleton: ошибка создания не «залипает» — следующий вызов попробует снова. */
function getHighlighter(theme: SynthTheme): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    const pending = createHighlighter(theme)
    highlighterPromise = pending
    pending.catch(() => {
      if (highlighterPromise === pending) highlighterPromise = null
    })
  }
  return highlighterPromise
}

/** Грамматика языка грузится один раз и только для реально встреченных языков. */
function ensureLanguage(highlighter: HighlighterCore, language: string): Promise<void> {
  if (highlighter.getLoadedLanguages().includes(language)) return Promise.resolve()
  const existing = languageLoads.get(language)
  if (existing) return existing

  const spec = LANGUAGES[language]!
  const pending = (async () => {
    const module = await spec.load()
    await highlighter.loadLanguage(module)
  })()
  languageLoads.set(language, pending)
  pending.catch(() => languageLoads.delete(language))
  return pending
}

/** Тема регистрируется в живом инстансе при смене палитры (языки остаются). */
async function ensureTheme(highlighter: HighlighterCore, theme: SynthTheme): Promise<void> {
  if (highlighter.getLoadedThemes().includes(theme.name)) return
  const existing = themeLoads.get(theme.name)
  if (existing) return existing

  const pending = highlighter.loadTheme(theme.registration)
  themeLoads.set(theme.name, pending)
  pending.catch(() => themeLoads.delete(theme.name))
  return pending
}

/**
 * HTML **содержимого** `<pre>`: shiki отдаёт `<pre><code>…</code></pre>`,
 * нам нужны только строки (`<span class="line">`), чтобы вставить их в наш
 * `<code>` — внешний `<pre>` и его inline-фон не нужны.
 */
function extractCodeHtml(html: string): string | null {
  const codeOpen = html.indexOf('<code')
  if (codeOpen === -1) return null
  const contentStart = html.indexOf('>', codeOpen)
  const contentEnd = html.lastIndexOf('</code>')
  if (contentStart === -1 || contentEnd <= contentStart) return null
  return html.slice(contentStart + 1, contentEnd)
}

/**
 * Подсветка кода: HTML для содержимого `<code>` или `null`
 * (неизвестный язык, превышение лимитов, ошибка shiki — без исключений).
 */
export async function highlightCode(code: string, lang: string): Promise<string | null> {
  const language = resolveHighlightLanguage(lang)
  if (!language || !code) return null
  if (code.length > MAX_HIGHLIGHT_CHARS) return null
  if (code.split('\n').length > MAX_HIGHLIGHT_LINES) return null

  const cacheKey = `${language}\0${code}`
  const cached = cache.get(cacheKey)
  if (cached !== undefined) return cached

  try {
    const theme = currentTheme()
    const highlighter = await getHighlighter(theme)
    await Promise.all([ensureTheme(highlighter, theme), ensureLanguage(highlighter, language)])
    const html = extractCodeHtml(highlighter.codeToHtml(code, { lang: language, theme: theme.name }))
    if (!html) return null
    if (cache.size >= CACHE_LIMIT) cache.clear()
    cache.set(cacheKey, html)
    return html
  } catch (error) {
    console.debug('[markdown/highlight] shiki failed, leaving code plain:', error)
    return null
  }
}
