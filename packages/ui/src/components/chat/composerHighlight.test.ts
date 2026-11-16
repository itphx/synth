import { describe, expect, it } from 'vitest'
import { highlightComposer } from './composerHighlight'

function kinds(text: string) {
  return Object.fromEntries(highlightComposer(text).filter((part) => part.kind).map((part) => [part.text, part.kind]))
}

describe('highlightComposer — токены композера (ADR-126)', () => {
  it('подсвечивает команду, skill, snippet и mention', () => {
    expect(kinds('/review @alice #sig $brainstorming')).toEqual({
      '/review': 'command',
      '@alice': 'mention',
      '#sig': 'snippet',
      '$brainstorming': 'skill',
    })
  })

  it('не считает токенами $5, #123, ##, email и путь без @', () => {
    expect(kinds('цена $5 и #123, ## heading, a@b.com, src/index.ts')).toEqual({})
  })

  it('игнорирует fenced- и inline-code', () => {
    expect(kinds('```\n/review #sig @alice\n```\n`$skill`')).toEqual({})
  })

  it('сохраняет исходный текст без потерь', () => {
    const text = 'привет /review\n@alice #sig $skill'
    expect(highlightComposer(text).map((part) => part.text).join('')).toBe(text)
  })
})

describe('highlightComposer — `!`-скрипт (ADR-126 §5)', () => {
  it('подсвечивает `!`-скрипт в начале сообщения', () => {
    expect(kinds('!dev')).toEqual({ '!dev': 'script' })
    expect(kinds('  !dev build')).toEqual({ '!dev': 'script' })
    expect(kinds('!dev-2')).toEqual({ '!dev-2': 'script' })
  })

  it('`!` в середине текста — обычный символ', () => {
    expect(kinds('запусти !dev')).toEqual({})
    expect(kinds('a!b')).toEqual({})
  })

  it('`!` без имени, `!=` и `!!` токеном не являются', () => {
    expect(kinds('!')).toEqual({})
    expect(kinds('! dev')).toEqual({})
    expect(kinds('!= 5')).toEqual({})
    expect(kinds('!!')).toEqual({})
  })

  it('имя с неверным началом (`!-dev`, `!Dev`) токеном не является', () => {
    expect(kinds('!-dev')).toEqual({})
    expect(kinds('!Dev')).toEqual({})
  })

  it('code-блок и inline-code не подсвечиваются', () => {
    expect(kinds('```\n!dev\n```')).toEqual({})
    expect(kinds('`!dev`')).toEqual({})
  })

  it('email-подобное не превращается в скрипт', () => {
    expect(kinds('user!name@example.com')).toEqual({})
  })
})
