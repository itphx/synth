import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { LivePart, MessageData } from '@/stores/chatStore'
import { copyMessageText, markdownToPlainText, messageVisibleText } from './messageCopy'

function makeMessage(overrides: Partial<MessageData> = {}): MessageData {
  return {
    index: 0,
    role: 'assistant',
    content: '',
    disabled: false,
    pinned: false,
    hidden: false,
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('messageVisibleText: копируется видимый текст, а не `content`', () => {
  it('обрезает хвостовые переносы строк', () => {
    const message = makeMessage({ content: 'Ответ модели\n\n' })
    expect(messageVisibleText(message)).toBe('Ответ модели')
  })

  it('внутренние переводы строк сохраняются', () => {
    const message = makeMessage({ content: 'первая\n\nвторая\n\n' })
    expect(messageVisibleText(message)).toBe('первая\n\nвторая')
  })

  it('две текстовые части склеиваются через пустую строку', () => {
    const message = makeMessage({
      content: 'не используется',
      parts: [
        { id: 'msg:text:0', type: 'text', data: 'первая часть' },
        { id: 'msg:text:1', type: 'text', data: 'вторая часть' },
      ],
    })
    expect(messageVisibleText(message)).toBe('первая часть\n\nвторая часть')
  })

  it('reasoning в копию не попадает', () => {
    const message = makeMessage({
      content: '<reasoning>думаю</reasoning>\n\nОтвет',
      parts: [
        { id: 'msg:reasoning:0', type: 'reasoning', data: 'думаю' },
        { id: 'msg:text:0', type: 'text', data: 'Ответ\n\n' },
      ],
    })
    expect(messageVisibleText(message)).toBe('Ответ')
  })

  it('без parts — фоллбек на content', () => {
    const message = makeMessage({ content: '   ', parts: null })
    expect(messageVisibleText(message)).toBe('')
    expect(messageVisibleText(makeMessage({ content: 'Просто текст' }))).toBe('Просто текст')
  })

  it('сообщение только из reasoning → копировать нечего', () => {
    const message = makeMessage({
      content: '<reasoning>думаю</reasoning>',
      parts: [{ id: 'msg:reasoning:0', type: 'reasoning', data: 'думаю' }],
    })
    expect(messageVisibleText(message)).toBe('')
  })

  it('без parts вырезает служебные блоки ядра из legacy-`content`', () => {
    const message = makeMessage({
      content:
        'Ответ\n\n<reasoning>думал</reasoning>\n<tool_call name="x">{}</tool_call>хвост   ',
      parts: null,
    })
    expect(messageVisibleText(message)).toBe('Ответ\n\nхвост')
  })

  it('без parts вырезает `tool_result` и `session_reference`', () => {
    const message = makeMessage({
      content:
        'Начало\n\n<tool_result name="fs_read" is_error="false">file body</tool_result>\n\nТекст\n\n<session_reference session_id="s1">ref</session_reference>  ',
    })
    expect(messageVisibleText(message)).toBe('Начало\n\nТекст')
  })

  it('при наличии частей legacy-`content` с тегами не используется', () => {
    const message = makeMessage({
      content: '<reasoning>думал</reasoning>\n\n<tool_result name="x">out</tool_result>',
      parts: [{ id: 'msg:text:0', type: 'text', data: 'Чистый текст\n\n' }],
    })
    expect(messageVisibleText(message)).toBe('Чистый текст')
  })

  it('текст из частей не стрипуется: `<tool_result>` пользователя сохраняется', () => {
    const literal = 'Пример:\n\n<tool_result name="x">out</tool_result>'
    const message = makeMessage({
      parts: [{ id: 'msg:text:0', type: 'text', data: literal }],
    })
    expect(messageVisibleText(message)).toBe(literal)
  })

  it('пустое сообщение → пустая строка', () => {
    expect(messageVisibleText(makeMessage({ content: '' }))).toBe('')
  })

  it('живые части важнее снимка истории', () => {
    const message = makeMessage({
      id: 'm1',
      parts: [{ id: 'msg:text:0', type: 'text', data: 'старый' }],
    })
    const live: LivePart[] = [{ id: 'msg:text:0', type: 'text', text: 'новый' }]
    expect(messageVisibleText(message, live)).toBe('новый')
  })
})

describe('markdownToPlainText: текст без разметки', () => {
  it('снимает маркеры выделения и инлайн-кода', () => {
    expect(markdownToPlainText('**жирный**')).toBe('жирный')
    expect(markdownToPlainText('`код`')).toBe('код')
    expect(markdownToPlainText('***всё сразу***')).toBe('всё сразу')
  })

  it('ссылка → подпись', () => {
    expect(markdownToPlainText('[текст](https://x)')).toBe('текст')
  })

  it('fenced-блок → код без ``` и без языка', () => {
    expect(markdownToPlainText('```ts\nconst a = 1\n```')).toBe('const a = 1')
  })

  it('список → строки с маркерами', () => {
    expect(markdownToPlainText('- один\n- два')).toBe('- один\n- два')
    expect(markdownToPlainText('1. один\n2. два')).toBe('1. один\n2. два')
  })

  it('вложенный список — с отступом 2 пробела', () => {
    expect(markdownToPlainText('- один\n  - вложенный')).toBe('- один\n  - вложенный')
  })

  it('таблица → строки через табуляцию', () => {
    const md = '| A | B |\n|---|---|\n| 1 | 2 |'
    expect(markdownToPlainText(md)).toBe('A\tB\n1\t2')
  })

  it('заголовок и абзац разделяются пустой строкой, хвост обрезан', () => {
    expect(markdownToPlainText('# Заголовок\n\nАбзац\n\n\n\n')).toBe('Заголовок\n\nАбзац')
  })

  it('html-теги вырезаются', () => {
    expect(markdownToPlainText('текст <b>важный</b>')).toBe('текст важный')
  })

  it('вложенные конструкции не падают', () => {
    const md = '> **цитата** со [ссылкой](https://x)\n>\n> - `код` в списке'
    const text = markdownToPlainText(md)
    expect(text).toContain('цитата')
    expect(text).toContain('ссылкой')
    expect(text).toContain('- код')
    expect(text).not.toContain('**')
    expect(text).not.toContain('](')
  })
})

describe('copyMessageText: режимы копирования', () => {
  let writeText: ReturnType<typeof vi.fn>

  beforeEach(() => {
    writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    })
  })

  it('режим markdown кладёт исходный markdown, хвост обрезан', async () => {
    const message = makeMessage({ content: '**жирный**\n\n' })
    await expect(copyMessageText(message, 'markdown')).resolves.toBe(true)
    expect(writeText).toHaveBeenCalledWith('**жирный**')
  })

  it('режим plain кладёт текст без разметки, хвост обрезан', async () => {
    const message = makeMessage({ content: '**жирный**\n\n' })
    await expect(copyMessageText(message, 'plain')).resolves.toBe(true)
    expect(writeText).toHaveBeenCalledWith('жирный')
  })

  it('пустой текст не копируется', async () => {
    await expect(copyMessageText(makeMessage({ content: '   \n\n' }), 'markdown')).resolves.toBe(false)
    expect(writeText).not.toHaveBeenCalled()
  })

  it('ошибка буфера обмена не пробрасывается', async () => {
    writeText.mockRejectedValue(new Error('denied'))
    await expect(copyMessageText(makeMessage({ content: 'текст' }), 'markdown')).resolves.toBe(false)
  })
})
