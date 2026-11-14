import { describe, expect, it } from 'vitest'
import { highlightComposer } from './composerHighlight'

function kinds(text: string) {
  return Object.fromEntries(highlightComposer(text).filter((part) => part.kind).map((part) => [part.text, part.kind]))
}

describe('highlightComposer — токены композера (ADR-141)', () => {
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
