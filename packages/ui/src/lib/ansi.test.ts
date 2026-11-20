// Тесты разбора ANSI-последовательностей (`lib/ansi.ts`).
//
// Проверяем ровно то, от чего зависит рендер лога: 16 базовых цветов, 256 и
// truecolor, начертания и их сброс, терминальную перезапись `\r`/`\b`
// (прогресс-бар показывает финальный кадр), выбрасывание «чужих»
// последовательностей (OSC, не-SGR CSI, одиночные ESC-пары) и защиту от
// фриза на гигантском логе.

import { describe, it, expect } from 'vitest'

import {
  DEFAULT_MAX_ANSI_CHARS,
  parseAnsi,
  stripAnsiText,
  type AnsiToken,
} from './ansi'

const ESC = '\u001b'

/** Текст первой строки разбора (склейка токенов). */
function firstLine(text: string): string {
  return (parseAnsi(text).lines[0] ?? []).map((token) => token.text).join('')
}

/** Строки разбора плоским текстом. */
function lines(text: string): string[] {
  return parseAnsi(text).lines.map((line) => line.map((token) => token.text).join(''))
}

/** Первый токен разбора (удобно для проверки оформления). */
function firstToken(text: string): AnsiToken {
  return parseAnsi(text).lines[0]![0]!
}

describe('parseAnsi: 16 базовых цветов', () => {
  it('SGR 30-37 дают имена цветов, 39 снимает цвет', () => {
    const tokens = parseAnsi(`${ESC}[31mred${ESC}[39mplain`).lines[0]!
    expect(tokens).toEqual([{ text: 'red', fg: 'red' }, { text: 'plain' }])
  })

  it('SGR 40-47 задают фон, 49 его снимает', () => {
    const tokens = parseAnsi(`${ESC}[42mok${ESC}[49mx`).lines[0]!
    expect(tokens).toEqual([{ text: 'ok', bg: 'green' }, { text: 'x' }])
  })

  it('SGR 90-97 — яркие варианты, 100-107 — яркий фон', () => {
    expect(firstToken(`${ESC}[90mgray`).fg).toBe('bright-black')
    expect(firstToken(`${ESC}[97mwhite`).fg).toBe('bright-white')
    expect(firstToken(`${ESC}[101mbg`).bg).toBe('bright-red')
  })

  it('несколько параметров в одной последовательности применяются вместе', () => {
    const token = firstToken(`${ESC}[1;4;33mwarn${ESC}[0m`)
    expect(token).toEqual({ text: 'warn', bold: true, underline: true, fg: 'yellow' })
  })
})

describe('parseAnsi: начертания и сброс', () => {
  it('bold/dim включаются 1/2 и снимаются 22', () => {
    const tokens = parseAnsi(`${ESC}[1mb${ESC}[22mn`).lines[0]!
    expect(tokens).toEqual([{ text: 'b', bold: true }, { text: 'n' }])

    const dim = parseAnsi(`${ESC}[2md${ESC}[22mn`).lines[0]!
    expect(dim).toEqual([{ text: 'd', dim: true }, { text: 'n' }])
  })

  it('italic/underline снимаются 23/24', () => {
    const tokens = parseAnsi(`${ESC}[3mi${ESC}[23m${ESC}[4mu${ESC}[24m`).lines[0]!
    expect(tokens).toEqual([{ text: 'i', italic: true }, { text: 'u', underline: true }])
  })

  it('SGR 0 сбрасывает и цвет, и начертания', () => {
    const tokens = parseAnsi(`${ESC}[1;31merr${ESC}[0mplain`).lines[0]!
    expect(tokens).toEqual([{ text: 'err', bold: true, fg: 'red' }, { text: 'plain' }])
  })

  it('SGR 7 меняет местами цвет текста и фона, 27 возвращает обратно', () => {
    const token = firstToken(`${ESC}[31;42m${ESC}[7mx`)
    expect(token.fg).toBe('green')
    expect(token.bg).toBe('red')

    const back = firstToken(`${ESC}[31m${ESC}[7m${ESC}[27mx`)
    expect(back.fg).toBe('red')
    expect(back.bg).toBeUndefined()
  })
})

describe('parseAnsi: расширенные цвета', () => {
  it('38;5;n — палитра 256: куб и серая шкала', () => {
    expect(firstToken(`${ESC}[38;5;196mX`).fg).toBe('rgb(255, 0, 0)')
    expect(firstToken(`${ESC}[38;5;244mX`).fg).toBe('rgb(128, 128, 128)')
    expect(firstToken(`${ESC}[48;5;21mX`).bg).toBe('rgb(0, 0, 255)')
  })

  it('38;5;n при n < 16 остаётся базовым цветом темы', () => {
    expect(firstToken(`${ESC}[38;5;1mX`).fg).toBe('red')
    expect(firstToken(`${ESC}[38;5;9mX`).fg).toBe('bright-red')
  })

  it('38;2;r;g;b — truecolor', () => {
    expect(firstToken(`${ESC}[38;2;18;52;86mX`).fg).toBe('rgb(18, 52, 86)')
    expect(firstToken(`${ESC}[48;2;1;2;3mX`).bg).toBe('rgb(1, 2, 3)')
  })

  it('колоночная запись 38:5:n и 38:2:cs:r:g:b тоже понимается', () => {
    expect(firstToken(`${ESC}[38:5:196mX`).fg).toBe('rgb(255, 0, 0)')
    expect(firstToken(`${ESC}[38:2::18:52:86mX`).fg).toBe('rgb(18, 52, 86)')
  })

  it('битый истинный цвет не съедает текст и не ломает разбор', () => {
    const tokens = parseAnsi(`${ESC}[38;2;1;2mtext`).lines[0]!
    expect(tokens.map((token) => token.text).join('')).toBe('text')
  })
})

describe('parseAnsi: терминальная семантика управляющих', () => {
  it('\\r перезаписывает строку: прогресс-бар показывает финальный кадр', () => {
    const parsed = parseAnsi('\r 10%\r 55%\r100%')
    expect(parsed.lines).toHaveLength(1)
    expect(parsed.lines[0]!.map((token) => token.text).join('')).toBe('100%')
  })

  it('\\r с более коротким кадром оставляет хвост предыдущего (как в терминале)', () => {
    expect(firstLine('abcdef\rXY')).toBe('XYcdef')
  })

  it('\\b сдвигает курсор и перезаписывает символ', () => {
    expect(firstLine('abc\bX')).toBe('abX')
    // В начале строки возврат назад — no-op.
    expect(firstLine('\bX')).toBe('X')
  })

  it('перезапись сохраняет оформление нового фрагмента (токены не склеиваются)', () => {
    const tokens = parseAnsi(`abc\r${ESC}[31mXY`).lines[0]!
    expect(tokens.map((token) => ({ ...token }))).toEqual([
      { text: 'XY', fg: 'red' },
      { text: 'c' },
    ])
  })

  it('\\t и переводы строк сохраняются', () => {
    expect(lines('a\tb\nc')).toEqual(['a\tb', 'c'])
  })

  it('прочие управляющие символы (BEL, DEL) выбрасываются', () => {
    expect(firstLine('a\u0007b\u007fc')).toBe('abc')
  })
})

describe('parseAnsi: прочие последовательности выбрасываются', () => {
  it('OSC с BEL и со ST', () => {
    expect(firstLine(`${ESC}]0;заголовок\u0007text`)).toBe('text')
    expect(firstLine(`${ESC}]8;;http://x${ESC}\\link`)).toBe('link')
  })

  it('не-SGR CSI: очистка строки, курсор, приватные режимы', () => {
    expect(firstLine(`${ESC}[2K${ESC}[1A${ESC}[?25ltext`)).toBe('text')
  })

  it('DCS и charset-пары', () => {
    expect(firstLine(`${ESC}P1;2|payload${ESC}\\text`)).toBe('text')
    expect(firstLine(`${ESC}(Btext`)).toBe('text')
  })

  it('одиночные ESC-пары', () => {
    expect(firstLine(`${ESC}7text${ESC}8`)).toBe('text')
  })

  it('ни в одном результате не остаётся ESC', () => {
    const sample = [
      `${ESC}[1;31mbold red${ESC}[0m`,
      `${ESC}]0;title\u0007`,
      `${ESC}[38;2;1;2;3mrgb${ESC}[m`,
      `${ESC}[?1049h alt screen${ESC}[?1049l`,
      `${ESC}(B`,
      `${ESC}7${ESC}8`,
      'plain\u0007text',
    ].join('\n')

    const parsed = parseAnsi(sample)
    const flat = parsed.lines.map((line) => line.map((token) => token.text).join('')).join('\n')
    expect(flat).not.toContain(ESC)
    expect(flat).not.toContain('\u0007')
    expect(flat).toContain('bold red')
    expect(flat).toContain('alt screen')
    expect(stripAnsiText(sample)).not.toContain(ESC)
  })

  it('незакрытая последовательность в конце текста просто отбрасывается', () => {
    expect(firstLine(`text${ESC}[38;5;`)).toBe('text')
    expect(firstLine(`text${ESC}]0;unfinished`)).toBe('text')
  })
})

describe('parseAnsi: строки и токены', () => {
  it('пустой вход — одна пустая строка, без токенов', () => {
    expect(parseAnsi('').lines).toEqual([[]])
  })

  it('перевод строки создаёт новую строку, оформление переносится', () => {
    const parsed = parseAnsi(`${ESC}[32ma\nb${ESC}[0mc`)
    expect(parsed.lines).toEqual([
      [{ text: 'a', fg: 'green' }],
      [{ text: 'b', fg: 'green' }, { text: 'c' }],
    ])
  })
})

describe('stripAnsiText', () => {
  it('убирает коды и применяет перезапись', () => {
    expect(stripAnsiText(`${ESC}[32mPASS${ESC}[0m a.test.ts`)).toBe('PASS a.test.ts')
    expect(stripAnsiText('\r 10%\r100%')).toBe('100%')
  })

  it('обычный текст без кодов не меняется (кроме терминальной перезаписи)', () => {
    expect(stripAnsiText('строка 1\nстрока 2\n')).toBe('строка 1\nстрока 2\n')
  })
})

describe('parseAnsi: защита от фриза на большом логе', () => {
  it('по умолчанию потолок ~400 000 символов', () => {
    expect(DEFAULT_MAX_ANSI_CHARS).toBe(400_000)
  })

  it('длиннее потолка — разбирается хвост с начала строки, clipped: true', () => {
    const head = `${ESC}[31mold line\n`
    const tail = 'fresh line\n'
    const filler = 'x'.repeat(50)
    const text = head + (filler + '\n').repeat(20) + tail

    const parsed = parseAnsi(text, { maxChars: 30 })
    expect(parsed.clipped).toBe(true)

    const flat = parsed.lines.map((line) => line.map((token) => token.text).join('')).join('\n')
    expect(flat).toContain('fresh line')
    expect(flat).not.toContain('old line')
    // Хвост начинается с целой строки, а не с её середины.
    expect(flat.startsWith('fresh line')).toBe(true)
    expect(flat).not.toContain(ESC)
  })

  it('текст короче потолка не обрезается', () => {
    const parsed = parseAnsi('short', { maxChars: 100 })
    expect(parsed.clipped).toBe(false)
    expect(parsed.lines[0]!.map((token) => token.text).join('')).toBe('short')
  })

  it('большой лог разбирается линейно (нет катастрофического бэктрекинга)', () => {
    const chunk = `${ESC}[32mok${ESC}[0m ${'x'.repeat(80)}\r\n`
    const text = chunk.repeat(4000) // ~370 000 символов

    const started = performance.now()
    const parsed = parseAnsi(text)
    const elapsed = performance.now() - started

    expect(parsed.clipped).toBe(false)
    expect(parsed.lines.length).toBeGreaterThan(4000)
    // Порог заведомо щедрый: линейный проход укладывается в десятки мс,
    // квадратичный или регулярки с бэктрекингом — нет.
    expect(elapsed).toBeLessThan(2000)
  })
})
