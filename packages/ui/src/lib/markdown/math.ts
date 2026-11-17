/**
 * Формулы в markdown — KaTeX, **лениво**.
 *
 * Разбор: расширение marked (`createMathExtension`) даёт два типа токенов —
 * `mathBlock` (блочный `$$…$$`) и `mathInline` (инлайновый `$$…$$` внутри
 * абзаца). Одинарный `$` **не** формула: `$5`, `$HOME` и прочие цены и
 * переменные в ответах агента остаются текстом — иначе они превращались бы
 * в мусор (а одиночный `$` в TeX — это начало команды).
 *
 * Рендер — по образцу подсветки кода (shiki): сама библиотека и её шрифты
 * грузятся **по требованию** (`import('katex')` + `import('katex/dist/katex.min.css')`
 * внутри `renderMathInPlace`), поэтому в основной бандл KaTeX не попадает.
 *
 * Безопасность: разметку формулы собирает marked (не пользователь), исходник
 * TeX экранируется и кладётся **текстом** внутрь элемента — никаких сырых
 * атрибутов с TeX (запятые, кавычки и переносы ломают атрибуты). Пока формула
 * не отрисована, этот же текст служит фоллбеком и его можно скопировать.
 * KaTeX вызывается с `trust: false` — опасные команды (`\href`,
 * `\includegraphics`) не выполняются.
 */
import type { MarkedExtension, Tokens } from 'marked'

/** Токен формулы: `text` — исходник TeX без обрамляющих `$$`. */
export interface MathToken extends Tokens.Generic {
  type: 'mathBlock' | 'mathInline'
  text: string
}

/**
 * Блочная формула: `$$…$$` (возможно многострочный) — отдельной строкой.
 *
 * Два условия:
 *  - закрывающие `$$` стоят в конце строки: иначе `$$a$$ в тексте` остаётся
 *    инлайновой формулой внутри абзаца, а не блоком;
 *  - внутри нет `$$`: строка `$$a$$ и $$b$$` — это **две** инлайновые
 *    формулы, а не одна битая блочная.
 */
const MATH_BLOCK_PATTERN = /^\$\$((?:(?!\$\$)[\s\S])*?)\$\$(?:\n+|$)/

/**
 * Инлайновая формула: `$$…$$` внутри абзаца.
 *
 * Ленивая пара (`+?`) — внутри абзаца берётся **одна** формула: `$$a$$ и $$b$$`
 * даст две, а не одну формулу с текстом посередине.
 */
const MATH_INLINE_PATTERN = /^\$\$([\s\S]+?)\$\$/

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

/** Экранирование текста перед вставкой в HTML (исходник TeX — произвольный). */
function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] ?? ch)
}

/**
 * Разметка формулы: исходник TeX — **текстом** внутри элемента.
 *
 * Разделители `$$` остаются в тексте: по ним `renderMathInPlace` понимает,
 * где исходник, а до рендера их видно пользователю (фоллбак + копирование).
 */
function mathHtml(kind: 'block' | 'inline', tex: string): string {
  const tag = kind === 'block' ? 'div' : 'span'
  // `$$${…}$$` — три доллара: два литеральных `$$` и интерполяция `${…}`
  // (в шаблонной строке `$${` — это `$` + интерполяция, а не `$$`).
  return `<${tag} class="md-math" data-math="${kind}">$$${escapeHtml(tex)}$$</${tag}>`
}

/**
 * Расширение marked: блочные и инлайновые формулы в `$$…$$`.
 *
 * Расширение **не** трогает глобальный `marked`: его подключают на локальном
 * инстансе (`new Marked(createMathExtension())`) — см. `MarkdownContent.tsx`.
 */
export function createMathExtension(): MarkedExtension {
  return {
    extensions: [
      {
        name: 'mathBlock',
        level: 'block',
        start(src) {
          // `src` — остаток источника **без первого символа** (конвенция
          // marked: индексы `start` считаются от второго символа). Ищем `$$`
          // в начале строки: только там открывающий `$$` — блочная формула.
          // Остальное (например `$$a$$` в середине строки) — инлайновое.
          const match = /\n\$\$/.exec(src)
          return match ? match.index + 1 : undefined
        },
        tokenizer(src) {
          // Быстрая проверка: блочная формула открывается только `$$`.
          if (!src.startsWith('$$')) return undefined
          const match = MATH_BLOCK_PATTERN.exec(src)
          if (!match) return undefined
          return { type: 'mathBlock', raw: match[0], text: match[1].trim() }
        },
        renderer(token) {
          return mathHtml('block', (token as MathToken).text)
        },
      },
      {
        name: 'mathInline',
        level: 'inline',
        start(src) {
          // Индекс следующего `$$`: текст обрывается перед разделителем,
          // иначе обычный текстовый токен проглотил бы формулу целиком.
          const index = src.indexOf('$$')
          return index === -1 ? undefined : index
        },
        tokenizer(src) {
          if (!src.startsWith('$$')) return undefined
          const match = MATH_INLINE_PATTERN.exec(src)
          if (!match) return undefined
          return { type: 'mathInline', raw: match[0], text: match[1] }
        },
        renderer(token) {
          return mathHtml('inline', (token as MathToken).text)
        },
      },
    ],
  }
}

/** Модуль KaTeX (типы поставляются самим пакетом). */
type KatexModule = typeof import('katex')

/** Промис загрузки KaTeX: переиспользуется между вызовами. */
let katexPromise: Promise<KatexModule> | null = null

/**
 * Загрузить KaTeX и его стили — оба динамическим `import()`: Vite выносит их
 * в отдельный чанк, шрифты KaTeX — в `dist/assets`. CSS грузим «мягко»: без
 * стилей формула всё равно рисуется, ронять рендер из-за стилей нельзя.
 */
function loadKatex(): Promise<KatexModule> {
  if (!katexPromise) {
    const pending = (async () => {
      const [katex] = await Promise.all([
        import('katex'),
        import('katex/dist/katex.min.css').catch(() => undefined),
      ])
      return katex
    })()
    katexPromise = pending
    pending.catch(() => {
      // Ошибка загрузки не «залипает» — следующий вызов попробует снова.
      if (katexPromise === pending) katexPromise = null
    })
  }
  return katexPromise
}

/**
 * Общие опции KaTeX:
 *  - `throwOnError: false` — битый TeX не должен ронять рендер;
 *  - `trust: false` — запрещены опасные команды (`\href`, `\includegraphics`);
 *  - `strict: 'ignore'` — не ругаемся на нестрогий TeX (старые команды).
 */
const KATEX_OPTIONS = {
  throwOnError: false,
  strict: 'ignore',
  trust: false,
} as const

/** Срезать обрамляющие `$$` — внутри элемента лежит исходник с разделителями. */
function stripMathDelimiters(source: string): string {
  const trimmed = source.trim()
  if (trimmed.length >= 4 && trimmed.startsWith('$$') && trimmed.endsWith('$$')) {
    return trimmed.slice(2, -2)
  }
  return trimmed
}

/**
 * Элементы, которые уже рисует незавершённый проход.
 *
 * Эффект рендера может выполниться дважды (StrictMode, смена `html`), а
 * повторный проход по уже отрисованной формуле взял бы **исходник заново**
 * (после `katex.render` в элеменке лежит HTML KaTeX, а не TeX) — и сломал бы
 * формулу. Поэтому элемент помечается «в полёте» до `await`.
 */
const rendering = new WeakSet<HTMLElement>()

/**
 * Отрисовать формулы в готовом DOM контейнера.
 *
 * Элементы без `data-rendered` (то есть ещё не отрисованные) берут исходник
 * из `textContent`, срезают `$$` и отдают KaTeX. Ошибка (битый TeX, не
 * загрузилась библиотека) оставляет элемент **исходным текстом** — рендер не
 * падает.
 */
export async function renderMathInPlace(container: HTMLElement): Promise<void> {
  const targets: Array<{ element: HTMLElement; source: string }> = []
  for (const element of container.querySelectorAll<HTMLElement>('.md-math:not([data-rendered])')) {
    if (rendering.has(element)) continue
    rendering.add(element)
    // Исходник читаем **до** await: после рендера в элементе лежит HTML KaTeX.
    targets.push({ element, source: element.textContent ?? '' })
  }
  if (targets.length === 0) return

  try {
    const katex = await loadKatex()
    for (const { element, source } of targets) {
      const tex = stripMathDelimiters(source)
      const displayMode = element.dataset.math === 'block'
      try {
        katex.render(tex, element, { ...KATEX_OPTIONS, displayMode })
        // При `throwOnError: false` KaTeX не бросает ошибку, а рисует красный
        // `.katex-error` — для битой формулы лучше вернуть исходный текст.
        if (element.querySelector('.katex-error')) {
          element.textContent = source
          continue
        }
        element.dataset.rendered = '1'
      } catch (error) {
        element.textContent = source
        console.debug('[markdown/math] katex failed, leaving source as text:', error)
      }
    }
  } catch (error) {
    // KaTeX не загрузился (нет сети, битый чанк) — элементы остаются текстом.
    console.debug('[markdown/math] katex is unavailable, leaving source as text:', error)
  } finally {
    for (const { element } of targets) rendering.delete(element)
  }
}
