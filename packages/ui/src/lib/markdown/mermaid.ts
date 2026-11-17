/**
 * Диаграммы Mermaid — рендер **лениво**, по образцу формул (`math.ts`) и
 * подсветки кода (`highlight.ts`).
 *
 * Что происходит:
 *  - fence ` ```mermaid ` разбирается marked'ом в обычный блок кода
 *    (`.md-code[data-lang="mermaid"]`); разбор исходника и рендер — **разные**
 *    шаги: исходник нужен и для копирования, и для самого рендера;
 *  - библиотека (`beautiful-mermaid`) грузится **динамическим `import()`** —
 *    в entry-чанк она не попадает, отдельный ленивый чанк тянется только при
 *    первом блоке с диаграммой;
 *  - результат вставляется в DOM **после** санитайзера: allowlist DOMPurify не
 *    расширяем, а SVG/ASCII — доверенный вывод нашего генератора, а не
 *    пользовательский HTML.
 *
 * Почему исходник остаётся в DOM:
 *  кнопки «копировать»/«скачать» берут текст из `pre code.textContent`, и
 *  markdown-копия сообщения — тоже. Удалять или заменять исходник нельзя, поэтому
 *  при показе диаграммы блок кода **скрывается** (`hidden` + CSS), но остаётся в
 *  DOM. Пользователь может переключить «код ↔ диаграмма» кнопкой в шапке блока.
 *
 * Кэш: результат рендера кэшируется по ключу `${mode}:${source}` — одна и та же
 * диаграмма в ленте и в просмотрщике файла перерисовывается ноль раз. Кэш
 * ограничен (100 записей) и вытесняет самые старые записи.
 */
import { i18nText } from '@/lib/i18n'

/** Режим показа диаграмм: SVG, текст (ASCII) или только исходный код. */
export type MermaidMode = 'svg' | 'ascii' | 'off'

/** Модуль `beautiful-mermaid` (типы поставляются самим пакетом). */
type MermaidModule = typeof import('beautiful-mermaid')

/** Все допустимые режимы — источник истины для валидации (стор/профиль). */
const MERMAID_MODES: readonly MermaidMode[] = ['svg', 'ascii', 'off']

/** Значение по умолчанию: диаграмма рисуется схемой. */
export const DEFAULT_MERMAID_MODE: MermaidMode = 'svg'

/** Блок кода с исходником диаграммы (fence ` ```mermaid `). */
const MERMAID_BLOCK_SELECTOR = '.md-code[data-lang="mermaid"]'

/** Сколько результатов рендера держим в кэше. */
const MAX_CACHE_ENTRIES = 100

/** Проверка режима: неизвестное значение из профиля/хранилища — не режим. */
export function isMermaidMode(value: unknown): value is MermaidMode {
  return typeof value === 'string' && (MERMAID_MODES as readonly string[]).includes(value)
}

/** Нормализация режима: битое/отсутствующее значение → режим по умолчанию. */
export function normalizeMermaidMode(value: unknown): MermaidMode {
  return isMermaidMode(value) ? value : DEFAULT_MERMAID_MODE
}

/**
 * Палитра SVG — по CSS-переменным темы.
 *
 * Значения — **CSS-переменные**, а не цвета: тема меняется на лету, и SVG
 * подхватывает новые значения без перерисовки. `transparent: true` — фон не
 * заливаем (фон блока кода уже задан темой).
 */
const SVG_THEME = {
  bg: 'var(--surface-subtle, var(--card))',
  fg: 'var(--foreground)',
  line: 'var(--border)',
  accent: 'var(--primary)',
  muted: 'var(--muted-foreground)',
  transparent: true,
  font: 'var(--font-sans, sans-serif)',
} as const

/**
 * Убрать внешний `@import` шрифта из готового SVG.
 *
 * Библиотека подставляет `@import url('https://fonts.googleapis.com/…')` в
 * `<style>` внутри SVG. Наша CSP — `style-src 'self' 'unsafe-inline'`:
 * внешний шрифт всё равно не загрузится (браузер напишет в консоль ошибку
 * политики на каждую диаграмму), а текст рисуется системным шрифтом. Поэтому
 * импорт вырезаем — это вывод нашего генератора, не пользовательский HTML.
 */
function stripFontImports(svg: string): string {
  return svg.replace(/^[^\S\n]*@import url\('https:\/\/fonts\.googleapis\.com[^']*'\);[^\S\n]*$/gm, '')
}

/**
 * Кэш результатов рендера: `${mode}:${source}` → SVG/ASCII.
 *
 * Ограничен по размеру; при переполнении вытесняется самая старая запись
 * (Map хранит порядок вставки).
 */
const renderCache = new Map<string, string>()

function cacheGet(key: string): string | undefined {
  const cached = renderCache.get(key)
  if (cached === undefined) return undefined
  // Свежие записи переносим в конец — вытесняются самые старые.
  renderCache.delete(key)
  renderCache.set(key, cached)
  return cached
}

function cacheSet(key: string, value: string): void {
  renderCache.set(key, value)
  while (renderCache.size > MAX_CACHE_ENTRIES) {
    const oldest = renderCache.keys().next()
    if (oldest.done) break
    renderCache.delete(oldest.value)
  }
}

/**
 * Элементы, которые уже рисует незавершённый проход.
 *
 * Эффект рендера выполняется несколько раз (StrictMode, смена `html`, смена
 * режима) — повторный проход по блоку, который уже рисуется, взял бы исходник
 * заново и нарисовал бы вторую диаграмму. Поэтому блок помечается «в полёте»
 * **до** `await`.
 */
const rendering = new WeakSet<HTMLElement>()

/** Промис загрузки библиотеки: переиспользуется между вызовами. */
let mermaidPromise: Promise<MermaidModule> | null = null

/**
 * Загрузить `beautiful-mermaid`.
 *
 * Динамический `import()` — Vite выносит библиотеку (и её движок раскладки
 * ELK) в отдельный ленивый чанк: в entry-чанке статической ссылки нет.
 */
function loadMermaid(): Promise<MermaidModule> {
  if (!mermaidPromise) {
    const pending = import('beautiful-mermaid')
    mermaidPromise = pending
    pending.catch(() => {
      // Ошибка загрузки не «залипает» — следующий вызов попробует снова.
      if (mermaidPromise === pending) mermaidPromise = null
    })
  }
  return mermaidPromise
}

/** Исходник диаграммы: текст блока кода (тот же, что копируется). */
function readSource(block: HTMLElement): string {
  const code = block.querySelector('pre.md-code-pre code')
  return (code?.textContent ?? '').trim()
}

/** Вставить результат сразу после шапки блока кода (иначе — в начало блока). */
function insertAfterHead(block: HTMLElement, node: HTMLElement): void {
  const head = block.querySelector('.md-code-head')
  if (head && head.parentElement === block) {
    head.after(node)
    return
  }
  block.prepend(node)
}

/**
 * Снять прежний результат рендера: диаграмма, ASCII-блок, кнопка-переключатель
 * и маркер режима. Исходник при этом возвращается в вид (блок снова код).
 */
function clearRender(block: HTMLElement): void {
  block.querySelector('.md-mermaid-chart')?.remove()
  block.querySelector('.md-mermaid-ascii')?.remove()
  block.querySelector('[data-mermaid-toggle]')?.remove()
  delete block.dataset.mermaid
  delete block.dataset.showSource
  const pre = block.querySelector<HTMLElement>('pre.md-code-pre')
  if (pre) pre.hidden = false
}

/**
 * Показать исходник (`visible = true`) или диаграмму (`visible = false`).
 *
 * Исходник скрывается **двумя** способами: атрибутом `hidden` (работает и без
 * CSS) и правилом `styles/index.css` (`.md-code[data-mermaid]…`). Состояние
 * хранится на блоке — `data-show-source` — и читается CSS'ом.
 */
export function setMermaidSourceVisible(block: HTMLElement, visible: boolean): void {
  const pre = block.querySelector<HTMLElement>('pre.md-code-pre')
  if (pre) pre.hidden = !visible
  if (visible) block.dataset.showSource = 'true'
  else delete block.dataset.showSource
  const toggle = block.querySelector<HTMLButtonElement>('[data-mermaid-toggle]')
  toggle?.setAttribute('aria-pressed', visible ? 'true' : 'false')
}

/**
 * Кнопка «код/диаграмма» в шапке блока.
 *
 * Живёт в HTML из marked (шапка вставляется через `dangerouslySetInnerHTML`),
 * поэтому кнопку добавляем **после** санитайзера: allowlist DOMPurify не
 * расширяем. У кнопки есть видимая подпись (в отличие от иконок копирования и
 * скачивания) — иначе её не отличить от соседних иконок.
 */
function ensureToggleButton(block: HTMLElement): HTMLButtonElement | null {
  const existing = block.querySelector<HTMLButtonElement>('[data-mermaid-toggle]')
  if (existing) return existing
  const actions = block.querySelector('.md-code-actions')
  if (!actions) return null
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'md-code-toggle'
  button.setAttribute('data-mermaid-toggle', '')
  button.setAttribute('aria-pressed', 'false')
  button.textContent = i18nText('markdown.mermaid.toggle')
  // Переключатель — первым: иконки копирования/скачивания остаются справа.
  actions.prepend(button)
  return button
}

/** Нарисовать SVG-диаграмму (результат — доверенный вывод генератора). */
function applySvg(block: HTMLElement, svg: string): void {
  const chart = document.createElement('div')
  chart.className = 'md-mermaid-chart'
  chart.setAttribute('role', 'img')
  chart.setAttribute('aria-label', i18nText('markdown.mermaid.aria'))
  chart.innerHTML = stripFontImports(svg)
  insertAfterHead(block, chart)
}

/** Нарисовать ASCII-диаграмму (моноширинный текст). */
function applyAscii(block: HTMLElement, ascii: string): void {
  const pre = document.createElement('pre')
  pre.className = 'md-mermaid-ascii'
  pre.textContent = ascii.replace(/\n+$/, '')
  insertAfterHead(block, pre)
}

/** Отрисовать диаграмму (без кэша) в нужном режиме. */
function renderDiagram(mermaid: MermaidModule, mode: 'svg' | 'ascii', source: string): string {
  const key = `${mode}:${source}`
  const cached = cacheGet(key)
  if (cached !== undefined) return cached
  const result =
    mode === 'svg'
      ? stripFontImports(mermaid.renderMermaidSVG(source, SVG_THEME))
      : mermaid.renderMermaidASCII(source, { colorMode: 'none' })
  cacheSet(key, result)
  return result
}

/**
 * Убрать ранее отрисованные диаграммы из контейнера.
 *
 * Нужна при смене режима на `off`: разметка сообщения не меняется, React не
 * трогает DOM, и старая диаграмма осталась бы висеть поверх кода.
 */
export function clearMermaidInPlace(container: HTMLElement): void {
  for (const block of Array.from(container.querySelectorAll<HTMLElement>(MERMAID_BLOCK_SELECTOR))) {
    clearRender(block)
  }
}

/**
 * Отрисовать диаграммы в готовом DOM контейнера.
 *
 * Для каждого блока ` ```mermaid `:
 *  - режим `off` — ничего не рисуем (блок остаётся кодом);
 *  - блок уже нарисован в этом режиме — пропускаем (иначе диаграмма задвоится);
 *  - блок нарисован в другом режиме — прежний результат снимаем и рисуем заново;
 *  - ошибка (битый синтаксис, не загрузилась библиотека) — блок остаётся
 *    **кодом**, маркер режима не ставим, исключение наружу не выходит.
 */
export async function renderMermaidInPlace(container: HTMLElement, mode: MermaidMode): Promise<void> {
  if (mode === 'off') {
    clearMermaidInPlace(container)
    return
  }

  const targets: Array<{ block: HTMLElement; source: string }> = []
  for (const block of Array.from(container.querySelectorAll<HTMLElement>(MERMAID_BLOCK_SELECTOR))) {
    if (rendering.has(block)) continue
    // Уже нарисован в этом режиме — повторный проход не нужен.
    if (block.dataset.mermaid === mode) continue
    const source = readSource(block)
    if (!source) continue
    // Помечаем «в полёте» **до** await: повторный проход эффекта не должен
    // начать вторую отрисовку того же блока.
    rendering.add(block)
    // Прежний результат (другой режим) снимаем сразу — блок показывает ровно
    // один вид, а не «диаграмму поверх диаграммы».
    clearRender(block)
    targets.push({ block, source })
  }
  if (targets.length === 0) return

  let mermaid: MermaidModule
  try {
    mermaid = await loadMermaid()
  } catch (error) {
    console.debug('[markdown/mermaid] библиотека недоступна, блок остаётся кодом:', error)
    for (const { block } of targets) rendering.delete(block)
    return
  }

  for (const { block, source } of targets) {
    try {
      const result = renderDiagram(mermaid, mode, source)
      if (mode === 'svg') applySvg(block, result)
      else applyAscii(block, result)
      block.dataset.mermaid = mode
      ensureToggleButton(block)
      // Показываем диаграмму: исходник скрыт, но остаётся в DOM (копирование).
      setMermaidSourceVisible(block, false)
    } catch (error) {
      // Битый синтаксис или сбой рендера — блок остаётся кодом.
      console.debug('[markdown/mermaid] не удалось отрисовать диаграмму:', error)
      clearRender(block)
    } finally {
      rendering.delete(block)
    }
  }
}
