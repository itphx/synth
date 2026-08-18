import { describe, it, expect } from 'vitest'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { replaceSecretsInHtml, SECRET_PLACEHOLDER_REGEX } from './SecretPlaceholder'

// Те же ALLOWED_TAGS/ALLOWED_ATTR, что и в MarkdownContent — проверяем полный pipeline.
const ALLOWED_TAGS = [
  'p', 'br', 'strong', 'em', 'u', 's', 'del', 'code', 'pre',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'blockquote',
  'a', 'img', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
  'span', 'div', 'hr',
  'input', 'label',
]
const ALLOWED_ATTR = ['href', 'src', 'alt', 'title', 'class', 'id', 'type', 'checked', 'disabled', 'data-ph']

const HIDDEN_TEXT = 'Значение скрыто'

/** Полный pipeline как в MarkdownContent: lexer → parser → replaceSecretsInHtml → sanitize. */
function render(content: string, secrets?: Record<string, string>) {
  const tokens = marked.lexer(content)
  const raw = marked.parser(tokens)
  const withSpans = replaceSecretsInHtml(raw, secrets, HIDDEN_TEXT)
  const html = DOMPurify.sanitize(withSpans, { ALLOWED_TAGS, ALLOWED_ATTR })
  return { raw, withSpans, html }
}

/** textContent всех <code> элементов в отрендеренном HTML. */
function codeTextContents(html: string): string[] {
  const container = document.createElement('div')
  container.innerHTML = html
  return Array.from(container.querySelectorAll('code')).map((el) => el.textContent ?? '')
}

describe('replaceSecretsInHtml', () => {
  it('обычный текст: плейсхолдер → span «Значение скрыто» внутри <p>', () => {
    const { html } = render('Мой email: ⟦SYNTH_SECRET_1⟧, сохрани его.', {
      '⟦SYNTH_SECRET_1⟧': 'sk-abc123',
    })
    expect(html).toContain('<p>Мой email: <span class="synth-secret-ph')
    expect(html).toContain('data-ph="⟦SYNTH_SECRET_1⟧"')
    expect(html).toContain('data-revealed="0"')
    expect(html).toContain(`>${HIDDEN_TEXT}</span>`)

    const container = document.createElement('div')
    container.innerHTML = html
    const span = container.querySelector('p .synth-secret-ph')
    expect(span).not.toBeNull()
    expect(span?.textContent).toBe(HIDDEN_TEXT)
  })

  it('fenced code block: span — НАСТОЯЩИЙ элемент внутри <pre><code>, а не экранированный текст', () => {
    const content = '```\nEmail: ⟦SYNTH_SECRET_1⟧\n```'
    const { html } = render(content, { '⟦SYNTH_SECRET_1⟧': 'user@example.com' })
    expect(html).toContain('<pre><code>Email: <span class="synth-secret-ph ')
    expect(html).not.toContain('&lt;span')
    expect(html).not.toContain('synth-secret-ph">Значение скрыто&lt;/span')

    const container = document.createElement('div')
    container.innerHTML = html
    const span = container.querySelector('pre code .synth-secret-ph')
    expect(span).not.toBeNull()
    expect(span?.textContent).toBe(HIDDEN_TEXT)
  })

  it('fenced code block с языком: span внутри <pre><code>', () => {
    const content = '```text\nТелефон: +7 999 000 00 09\nEmail: ⟦SYNTH_SECRET_1⟧\n```'
    const { html } = render(content, { '⟦SYNTH_SECRET_1⟧': 'user@example.com' })
    expect(html).toContain('<pre><code')
    expect(html).toContain('<span class="synth-secret-ph ')
    expect(html).not.toContain('&lt;span')

    const container = document.createElement('div')
    container.innerHTML = html
    expect(container.querySelector('pre code .synth-secret-ph')).not.toBeNull()
  })

  it('inline code: span внутри <code>', () => {
    const content = 'Используйте `⟦SYNTH_SECRET_2⟧` в конфиге.'
    const { html } = render(content, { '⟦SYNTH_SECRET_2⟧': 'token-xyz' })
    expect(html).toContain('<code><span class="synth-secret-ph ')
    expect(html).toContain('data-ph="⟦SYNTH_SECRET_2⟧"')
    expect(html).not.toContain('&lt;span')

    const container = document.createElement('div')
    container.innerHTML = html
    const span = container.querySelector('code .synth-secret-ph')
    expect(span).not.toBeNull()
    expect(span?.textContent).toBe(HIDDEN_TEXT)
  })

  it('плейсхолдер без значения в secrets → unavailable-класс и title «Значение недоступно»', () => {
    const { html } = render('Ключ: ⟦SYNTH_SECRET_9⟧')
    expect(html).toContain('class="synth-secret-ph ')
    expect(html).toContain('cursor-default text-muted-foreground')
    expect(html).toContain('title="Значение недоступно"')
    expect(html).toContain(`>${HIDDEN_TEXT}</span>`)
  })

  it('несколько плейсхолдеров → несколько маркеров', () => {
    const { html } = render('A: ⟦SYNTH_SECRET_1⟧ B: ⟦SYNTH_SECRET_2⟧', {
      '⟦SYNTH_SECRET_1⟧': 'v1',
      '⟦SYNTH_SECRET_2⟧': 'v2',
    })
    const matches = html.match(/class="synth-secret-ph/g)
    expect(matches).toHaveLength(2)
    expect(html).toContain('data-ph="⟦SYNTH_SECRET_1⟧"')
    expect(html).toContain('data-ph="⟦SYNTH_SECRET_2⟧"')
  })

  it('сырого HTML нет в textContent ни одного <code>', () => {
    const content = [
      '```',
      'Email: ⟦SYNTH_SECRET_1⟧',
      '```',
      '',
      'Используйте `⟦SYNTH_SECRET_2⟧` в конфиге.',
    ].join('\n')
    const { html } = render(content, {
      '⟦SYNTH_SECRET_1⟧': 'user@example.com',
      '⟦SYNTH_SECRET_2⟧': 'token-xyz',
    })
    for (const text of codeTextContents(html)) {
      expect(text).not.toContain('<span')
      expect(text).not.toContain('synth-secret-ph')
    }
  })

  it('регрессия: контент без плейсхолдеров не меняется и рендерится как обычно', () => {
    const content = '```js\nconst x = 1;\n```\nОбычный `inline` текст.'
    const { raw, withSpans, html } = render(content)
    expect(withSpans).toBe(raw)
    expect(html).not.toContain('synth-secret-ph')
    expect(html).toContain('<pre><code')
    expect(html).toContain('const x = 1;')
  })

  it('повторные вызовы работают (глобальный regex сбрасывает lastIndex)', () => {
    const secrets = { '⟦SYNTH_SECRET_1⟧': 'v1' }
    const first = replaceSecretsInHtml('<p>⟦SYNTH_SECRET_1⟧</p>', secrets, HIDDEN_TEXT)
    const second = replaceSecretsInHtml('<p>⟦SYNTH_SECRET_1⟧</p>', secrets, HIDDEN_TEXT)
    expect(first).toContain('synth-secret-ph')
    expect(second).toContain('synth-secret-ph')
    expect(SECRET_PLACEHOLDER_REGEX.lastIndex).toBe(0)
  })
})
