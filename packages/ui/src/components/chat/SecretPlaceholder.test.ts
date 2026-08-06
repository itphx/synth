import { describe, it, expect } from 'vitest'
import { protectCodeBlocks, SECRET_PLACEHOLDER_REGEX } from './SecretPlaceholder'

/** Имитация подмены плейсхолдера из SecretMarkdown (строковый inline-маркер). */
function replaceSecrets(text: string): string {
  return text.replace(
    SECRET_PLACEHOLDER_REGEX,
    '<span class="synth-secret-ph" data-ph="⟦SYNTH_SECRET_1⟧">Значение скрыто</span>',
  )
}

function apply(content: string): string {
  const { protectedText, restoreCodeBlocks } = protectCodeBlocks(content)
  return restoreCodeBlocks(replaceSecrets(protectedText))
}

describe('protectCodeBlocks', () => {
  it('оставляет плейсхолдер буквальным внутри fenced code block ```', () => {
    const content = '```\nEmail: ⟦SYNTH_SECRET_1⟧\n```'
    const result = apply(content)
    expect(result).toContain('Email: ⟦SYNTH_SECRET_1⟧')
    expect(result).not.toContain('synth-secret-ph')
  })

  it('оставляет плейсхолдер буквальным внутри fenced code block с языком', () => {
    const content = '```text\nТелефон: +7 999 000 00 09\nEmail: ⟦SYNTH_SECRET_1⟧\n```'
    const result = apply(content)
    expect(result).toContain('Email: ⟦SYNTH_SECRET_1⟧')
    expect(result).not.toContain('synth-secret-ph')
  })

  it('оставляет плейсхолдер буквальным внутри ~~~ блока', () => {
    const content = '~~~\nEmail: ⟦SYNTH_SECRET_1⟧\n~~~'
    const result = apply(content)
    expect(result).toContain('Email: ⟦SYNTH_SECRET_1⟧')
    expect(result).not.toContain('synth-secret-ph')
  })

  it('оставляет плейсхолдер буквальным внутри inline code', () => {
    const content = 'Используйте `⟦SYNTH_SECRET_1⟧` в конфиге.'
    const result = apply(content)
    expect(result).toContain('`⟦SYNTH_SECRET_1⟧`')
    expect(result).not.toContain('synth-secret-ph')
  })

  it('заменяет плейсхолдер вне кода (регрессия рабочего случая)', () => {
    const content = 'Мой email: ⟦SYNTH_SECRET_1⟧, сохрани его.'
    const result = apply(content)
    expect(result).toContain('<span class="synth-secret-ph"')
    expect(result).toContain('Значение скрыто')
    // Голого плейсхолдера вне data-ph нет (внутри data-ph он остаётся по дизайну).
    expect(result.replace(/data-ph="[^"]*"/g, '')).not.toContain('⟦SYNTH_SECRET_1⟧')
  })

  it('раздельно обрабатывает код и обычный текст в одном сообщении', () => {
    const content =
      'Файл создан:\n\n```\nEmail: ⟦SYNTH_SECRET_1⟧\n```\n\nКлюч: ⟦SYNTH_SECRET_1⟧, inline: `⟦SYNTH_SECRET_1⟧`'
    const result = apply(content)
    expect(result).toContain('```\nEmail: ⟦SYNTH_SECRET_1⟧\n```')
    expect(result).toContain('`⟦SYNTH_SECRET_1⟧`')
    expect(result).toContain('<span class="synth-secret-ph" data-ph="⟦SYNTH_SECRET_1⟧">Значение скрыто</span>')
  })

  it('не трогает контент без плейсхолдеров', () => {
    const content = '```js\nconst x = 1;\n```\nОбычный `inline` текст.'
    const result = apply(content)
    expect(result).toBe(content)
  })
})
