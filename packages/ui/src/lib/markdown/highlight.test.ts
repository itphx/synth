import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * Тесты ленивого singleton'а подсветки. shiki мокается целиком: проверяем
 * логику (языки/лимиты/кэш/деградацию), а не токенизатор. Поэтому
 * `shiki/core`, `shiki/engine/oniguruma` и `shiki/langs/*` подменены, wasm не
 * грузится вовсе.
 */
const shiki = vi.hoisted(() => {
  const state = {
    codeToHtmlCalls: 0,
    languageLoads: 0,
    themeLoads: 0,
    shouldThrow: false,
    lastOptions: { lang: '', theme: '' },
    loadedLanguages: new Set<string>(),
    loadedThemes: new Set<string>(),
  }

  const highlighter = {
    codeToHtml(code: string, options: { lang: string; theme: string }) {
      state.codeToHtmlCalls += 1
      state.lastOptions = options
      if (state.shouldThrow) throw new Error('shiki boom')
      return `<pre class="shiki" style="background-color:#000"><code><span class="line">${code}</span></code></pre>`
    },
    loadLanguage: async (module: { default?: Array<{ name: string }> }) => {
      state.languageLoads += 1
      for (const registration of module.default ?? []) state.loadedLanguages.add(registration.name)
    },
    loadTheme: async (theme: { name: string }) => {
      state.themeLoads += 1
      state.loadedThemes.add(theme.name)
    },
    getLoadedLanguages: () => Array.from(state.loadedLanguages),
    getLoadedThemes: () => Array.from(state.loadedThemes),
  }

  return { state, highlighter }
})

vi.mock('shiki/core', () => ({
  createHighlighterCore: vi.fn(async () => shiki.highlighter),
}))
vi.mock('shiki/engine/oniguruma', () => ({
  createOnigurumaEngine: vi.fn(async () => ({})),
}))
vi.mock('shiki/langs/typescript.mjs', () => ({ default: [{ name: 'typescript' }] }))
vi.mock('shiki/langs/python.mjs', () => ({ default: [{ name: 'python' }] }))

import {
  clearHighlightCache,
  highlightCode,
  MAX_HIGHLIGHT_CHARS,
  MAX_HIGHLIGHT_LINES,
  resolveHighlightLanguage,
} from './highlight'

beforeEach(() => {
  clearHighlightCache()
  shiki.state.codeToHtmlCalls = 0
  shiki.state.languageLoads = 0
  shiki.state.themeLoads = 0
  shiki.state.shouldThrow = false
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('resolveHighlightLanguage', () => {
  it('алиасы fence сводятся к каноническому языку shiki', () => {
    expect(resolveHighlightLanguage('ts')).toBe('typescript')
    expect(resolveHighlightLanguage('TSX')).toBe('tsx')
    expect(resolveHighlightLanguage('js')).toBe('javascript')
    expect(resolveHighlightLanguage('sh')).toBe('bash')
    expect(resolveHighlightLanguage('yml')).toBe('yaml')
    expect(resolveHighlightLanguage('md')).toBe('markdown')
    expect(resolveHighlightLanguage('ts title="x"')).toBe('typescript')
  })

  it('неизвестный язык — null', () => {
    expect(resolveHighlightLanguage('text')).toBeNull()
    expect(resolveHighlightLanguage('mermaid')).toBeNull()
    expect(resolveHighlightLanguage('')).toBeNull()
  })
})

describe('highlightCode', () => {
  it('возвращает HTML содержимого <pre> (строки shiki), без внешнего <pre>', async () => {
    const html = await highlightCode('const a = 1', 'ts')

    expect(html).toBe('<span class="line">const a = 1</span>')
    expect(html).not.toContain('<pre')
    expect(shiki.state.lastOptions.lang).toBe('typescript')
  })

  it('неизвестный язык → null без запуска токенизатора', async () => {
    expect(await highlightCode('SELECT 1', 'mermaid')).toBeNull()
    expect(shiki.state.codeToHtmlCalls).toBe(0)
  })

  it('блок длиннее MAX_HIGHLIGHT_LINES → null', async () => {
    const long = Array.from({ length: MAX_HIGHLIGHT_LINES + 1 }, (_, i) => `line ${i}`).join('\n')

    expect(await highlightCode(long, 'ts')).toBeNull()
    expect(shiki.state.codeToHtmlCalls).toBe(0)
  })

  it('блок больше MAX_HIGHLIGHT_CHARS → null', async () => {
    const huge = `// ${'x'.repeat(MAX_HIGHLIGHT_CHARS)}`

    expect(await highlightCode(huge, 'ts')).toBeNull()
    expect(shiki.state.codeToHtmlCalls).toBe(0)
  })

  it('кэш: повторный вызов того же кода не токенизирует снова', async () => {
    const first = await highlightCode('const a = 1', 'ts')
    const second = await highlightCode('const a = 1', 'typescript')

    expect(second).toBe(first)
    expect(shiki.state.codeToHtmlCalls).toBe(1)

    await highlightCode('const b = 2', 'ts')
    expect(shiki.state.codeToHtmlCalls).toBe(2)
  })

  it('грамматика грузится один раз и только для встреченного языка', async () => {
    await highlightCode('print(1)', 'python')
    await highlightCode('print(2)', 'py')

    // python-мок отдаёт одну регистрацию, второй вызов берёт её из инстанса.
    expect(shiki.state.languageLoads).toBe(1)
    expect(shiki.state.loadedLanguages.has('python')).toBe(true)
  })

  it('ошибка shiki не бросает: null и console.debug', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})
    shiki.state.shouldThrow = true

    await expect(highlightCode('const a = 1', 'ts')).resolves.toBeNull()
    expect(debug).toHaveBeenCalled()
  })

  it('clearHighlightCache сбрасывает кэш HTML', async () => {
    await highlightCode('let x = 1', 'ts')
    clearHighlightCache()
    await highlightCode('let x = 1', 'ts')

    expect(shiki.state.codeToHtmlCalls).toBe(2)
  })
})
