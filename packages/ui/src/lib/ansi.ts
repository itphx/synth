// ANSI-последовательности → строки токенов для рендера в React.
//
// Зачем свой парсер: shell исполняется в PTY с `TERM=xterm-256color` и
// `COLORTERM=truecolor` (`packages/core/src/execution/inline-execution-port.ts`),
// поэтому программы (vitest, picocolors, git, pytest) включают цвета. Лог
// пишется байт-в-байт и в `<pre>` показывался как есть — пользователь видел
// `□[32m` вместо цвета. Здесь последовательности разбираются в структуру,
// которую `components/ansi/AnsiText` рендерит спанами. Новых зависимостей нет
// (инвариант 12), xterm.js не используется, хранилище лога не меняется.
//
// Модель разбора — «сетка» строк: каждый символ пишется в свою колонку, поэтому
// `\r` (прогресс-бары) и `\b` дают терминальную семантику — перезапись, а не
// накопление кадров. Стиль хранится ссылкой на неизменяемый объект: пока SGR не
// пришёл, все ячейки ссылаются на один и тот же объект, и склейка в токены идёт
// по ссылке (сравнение за O(1), никаких строковых ключей).
//
// Что выбрасывается целиком: все прочие CSI (`ESC[ … final`), OSC
// (`ESC] … BEL`/ST), DCS/SOS/PM/APC, charset-пары (`ESC ( B`), прочие
// ESC-пары и управляющие C0 (кроме `\n`, `\t`, `\r`, `\b`). Символа `\u001b`
// в результате не остаётся ни при каком входе.
//
// Ограничения, принятые осознанно:
// - 16 базовых цветов возвращаются именами (`red`, `bright-black`) — их
//   отображение задаёт тема; 256/truecolor — строкой `rgb(r, g, b)`.
// - `38;5;n` при `n < 16` тоже даёт имя базового цвета (тема важнее палитры).
// - `SGR 4:3` (curly underline) и прочие подпараметры не поддерживаются: важна
//   сохраняемость цвета, а не точная передача начертания.
// - Суррогатные пары (эмодзи) пишутся по половине на ячейку; при склейке в
//   токен они восстанавливаются, но перезапись `\r`/`\b` внутри пары даёт
//   битый символ (у реального терминала — та же проблема с шириной).

/** Фрагмент строки с одинаковым оформлением. */
export interface AnsiToken {
  text: string
  /** Цвет текста: имя базового цвета (`red`, `bright-black`) или `rgb(r, g, b)`. */
  fg?: string
  /** Цвет фона: то же соглашение, что у `fg`. */
  bg?: string
  bold?: boolean
  dim?: boolean
  italic?: boolean
  underline?: boolean
}

export interface ParseAnsiOptions {
  /**
   * Потолок длины входного текста. Длиннее — разбирается хвост с начала
   * строки, в результате `clipped: true`. Защита от фриза на гигантских логах.
   */
  maxChars?: number
}

export interface ParsedAnsi {
  lines: AnsiToken[][]
  /** Вход был обрезан по `maxChars` (показан только хвост). */
  clipped: boolean
}

/** Потолок разбора по умолчанию (~400 000 символов). */
export const DEFAULT_MAX_ANSI_CHARS = 400_000

/** Оформление без цвета (общий объект: склейка токенов сравнивает ссылки). */
const EMPTY_STYLE: Omit<AnsiToken, 'text'> = Object.freeze({})

type Style = Omit<AnsiToken, 'text'>

/** Имена 16 базовых цветов ANSI (SGR 30-37 / 90-97). */
const BASE_COLORS = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
] as const

/** Яркие варианты базовых цветов (SGR 90-97). */
const BRIGHT_COLORS = [
  'bright-black',
  'bright-red',
  'bright-green',
  'bright-yellow',
  'bright-blue',
  'bright-magenta',
  'bright-cyan',
  'bright-white',
] as const

/** Уровни 6×6×6 куба палитры xterm-256. */
const CUBE_LEVELS = [0, 95, 135, 175, 215, 255] as const

/** CSS-цвет `rgb(r, g, b)` с обрезкой каналов в 0…255. */
function rgbColor(r: number, g: number, b: number): string {
  const channel = (value: number): number =>
    Number.isFinite(value) ? Math.min(255, Math.max(0, Math.trunc(value))) : 0
  return `rgb(${channel(r)}, ${channel(g)}, ${channel(b)})`
}

/**
 * Цвет индекса палитры xterm-256 (`38;5;n` / `48;5;n`).
 *
 * 0…15 — имена базовых цветов (тема), 16…231 — куб 6×6×6, 232…255 — серая
 * шкала. Индекс вне диапазона обрезается.
 */
function color256(value: number): string {
  const n = Number.isFinite(value) ? Math.min(255, Math.max(0, Math.trunc(value))) : 0
  if (n < 8) return BASE_COLORS[n]!
  if (n < 16) return BRIGHT_COLORS[n - 8]!
  if (n < 232) {
    const index = n - 16
    return rgbColor(
      CUBE_LEVELS[Math.floor(index / 36)]!,
      CUBE_LEVELS[Math.floor((index % 36) / 6)]!,
      CUBE_LEVELS[index % 6]!,
    )
  }
  const level = 8 + (n - 232) * 10
  return rgbColor(level, level, level)
}

/** Копия стиля с изменённым цветом; `undefined` — снять цвет. */
function withColor(style: Style, key: 'fg' | 'bg', value: string | undefined): Style {
  const next: Style = { ...style }
  if (value === undefined) delete next[key]
  else next[key] = value
  return next
}

/** Копия стиля с изменённым флагом начертания. */
function withFlag(style: Style, key: 'bold' | 'dim' | 'italic' | 'underline', on: boolean): Style {
  const next: Style = { ...style }
  if (on) next[key] = true
  else delete next[key]
  return next
}

/**
 * `SGR 7` (reverse) — своп цвета текста и фона (как в терминале без отрисовки
 * курсора). `SGR 27` отменяет его обратным свопом, поэтому парное
 * `ESC[7m … ESC[27m` даёт исходное оформление.
 */
function withReverse(style: Style): Style {
  const next: Style = { ...style }
  if (style.bg === undefined) delete next.fg
  else next.fg = style.bg
  if (style.fg === undefined) delete next.bg
  else next.bg = style.fg
  return next
}

/**
 * Параметры SGR как список операций: элемент массива — одна операция,
 * подпараметры через `:` остаются вложенными (`38:5:196` → `[38, 5, 196]`).
 */
function parseSgrOps(raw: string): number[][] {
  const ops: number[][] = []
  for (const chunk of raw.split(';')) {
    const subs = chunk.split(':').map((part) => (part === '' ? 0 : Number(part)))
    // Мусор (нечисло) — операцию пропускаем: лучше потерять начертание,
    // чем проглотить текст из-за странной последовательности.
    if (subs.some((value) => !Number.isFinite(value))) continue
    ops.push(subs)
  }
  return ops
}

/** Цвет из компактной колоночной записи (`38:5:n`, `38:2:[cs:]r:g:b`). */
function colorFromSubs(op: number[]): string | undefined {
  const mode = op[1]
  if (mode === 5) {
    const index = op[2]
    return index === undefined ? undefined : color256(index)
  }
  if (mode === 2) {
    // Необязательный colorSpace-id спереди: значимы последние три канала.
    const tail = op.slice(2)
    if (tail.length < 3) return undefined
    return rgbColor(tail[tail.length - 3]!, tail[tail.length - 2]!, tail[tail.length - 1]!)
  }
  return undefined
}

/**
 * Применение SGR-последовательности к текущему стилю.
 *
 * Параметры могут занимать несколько операций (`38;2;r;g;b`), поэтому идём по
 * списку с индексом и «съедаем» хвост расширенного цвета.
 */
function applySgr(style: Style, raw: string): Style {
  const ops = parseSgrOps(raw)
  let next = style
  for (let k = 0; k < ops.length; k += 1) {
    const op = ops[k]!
    const code = op[0] ?? 0

    // Компактная запись с подпараметрами: `38:5:n`, `48:2:r:g:b`, `4:3`.
    if (op.length > 1) {
      if (code === 38 || code === 48) {
        const color = colorFromSubs(op)
        if (color !== undefined) next = withColor(next, code === 38 ? 'fg' : 'bg', color)
      } else if (code === 4) {
        next = withFlag(next, 'underline', true)
      }
      continue
    }

    if (code === 0) {
      next = EMPTY_STYLE
    } else if (code === 1) {
      next = withFlag(next, 'bold', true)
    } else if (code === 2) {
      next = withFlag(next, 'dim', true)
    } else if (code === 3) {
      next = withFlag(next, 'italic', true)
    } else if (code === 4) {
      next = withFlag(next, 'underline', true)
    } else if (code === 7 || code === 27) {
      next = withReverse(next)
    } else if (code === 22) {
      next = withFlag(withFlag(next, 'bold', false), 'dim', false)
    } else if (code === 23) {
      next = withFlag(next, 'italic', false)
    } else if (code === 24) {
      next = withFlag(next, 'underline', false)
    } else if (code >= 30 && code <= 37) {
      next = withColor(next, 'fg', BASE_COLORS[code - 30]!)
    } else if (code === 39) {
      next = withColor(next, 'fg', undefined)
    } else if (code >= 40 && code <= 47) {
      next = withColor(next, 'bg', BASE_COLORS[code - 40]!)
    } else if (code === 49) {
      next = withColor(next, 'bg', undefined)
    } else if (code >= 90 && code <= 97) {
      next = withColor(next, 'fg', BRIGHT_COLORS[code - 90]!)
    } else if (code >= 100 && code <= 107) {
      next = withColor(next, 'bg', BRIGHT_COLORS[code - 100]!)
    } else if (code === 38 || code === 48) {
      // Расширенный цвет в «плоской» записи: 38;5;n и 38;2;r;g;b.
      const mode = ops[k + 1]?.[0]
      const key = code === 38 ? 'fg' : 'bg'
      if (mode === 5) {
        const index = ops[k + 2]?.[0]
        if (index !== undefined) {
          next = withColor(next, key, color256(index))
          k += 2
        }
      } else if (mode === 2) {
        const r = ops[k + 2]?.[0]
        const g = ops[k + 3]?.[0]
        const b = ops[k + 4]?.[0]
        if (r !== undefined && g !== undefined && b !== undefined) {
          next = withColor(next, key, rgbColor(r, g, b))
          k += 4
        }
      }
    }
    // Остальные коды (blink, overline, шрифты, framed…) не отображаются.
  }
  return next
}

/** Индекс после CSI-последовательности (`ESC[ … final`); `-1` — не закрыта. */
function skipCsi(text: string, from: number): number {
  const length = text.length
  let index = from
  while (index < length) {
    const code = text.charCodeAt(index)
    // Final byte. Управляющий символ внутри — признак битой последовательности:
    // останавливаемся на нём, чтобы не съесть текст до конца файла.
    if (code >= 0x40 && code <= 0x7e) return index + 1
    if (code < 0x20 || code === 0x7f) return index
    index += 1
  }
  return -1
}

/** Индекс после строковой последовательности (OSC/DCS/…): до BEL или ST. */
function skipStringSequence(text: string, from: number): number {
  const length = text.length
  let index = from
  while (index < length) {
    const code = text.charCodeAt(index)
    if (code === 0x07 || code === 0x9c) return index + 1 // BEL / C1 ST
    if (code === 0x1b && text.charCodeAt(index + 1) === 0x5c) return index + 2 // ESC \
    index += 1
  }
  return length
}

/** Строка в виде сетки: символ + ссылка на стиль для каждой колонки. */
interface CellLine {
  chars: string[]
  styles: Style[]
}

/** Сетка → токены: подряд идущие ячейки с одним стилем склеиваются. */
function lineToTokens(line: CellLine): AnsiToken[] {
  const tokens: AnsiToken[] = []
  let current: Style = EMPTY_STYLE
  let buffer = ''
  let hasBuffer = false
  for (let index = 0; index < line.chars.length; index += 1) {
    const style = line.styles[index] ?? EMPTY_STYLE
    if (hasBuffer && style !== current) {
      tokens.push({ text: buffer, ...current })
      buffer = ''
      hasBuffer = false
    }
    current = style
    buffer += line.chars[index]
    hasBuffer = true
  }
  if (hasBuffer) tokens.push({ text: buffer, ...current })
  return tokens
}

/** Отбрасывает начало текста по потолку, стараясь начать с целой строки. */
function clipToTail(text: string, maxChars: number): { text: string; clipped: boolean } {
  if (!Number.isFinite(maxChars) || maxChars <= 0 || text.length <= maxChars) {
    return { text, clipped: false }
  }
  const cutoff = text.length - maxChars
  const nextLine = text.indexOf('\n', cutoff)
  // Нет перевода строки в хвосте — режем посередине строки: показывать хоть
  // что-то полезнее, чем пустоту.
  return { text: text.slice(nextLine === -1 ? cutoff : nextLine + 1), clipped: true }
}

/**
 * Разбирает текст с ANSI-последовательностями в строки токенов.
 *
 * Линейный проход по символам, без регулярок: на 400 000 символов лога нет ни
 * бэктрекинга, ни квадратичных склеек.
 */
export function parseAnsi(text: string, opts: ParseAnsiOptions = {}): ParsedAnsi {
  const source0 = typeof text === 'string' ? text : ''
  const { text: source, clipped } = clipToTail(source0, opts.maxChars ?? DEFAULT_MAX_ANSI_CHARS)
  const length = source.length

  const lines: CellLine[] = [{ chars: [], styles: [] }]
  let line = lines[0]!
  let col = 0
  let style: Style = EMPTY_STYLE
  let index = 0

  while (index < length) {
    const code = source.charCodeAt(index)

    // ESC: CSI (SGR и прочее), OSC, DCS-семейство, charset, одиночная пара.
    if (code === 0x1b) {
      const next = source.charCodeAt(index + 1)
      if (next === 0x5b /* [ */) {
        const end = skipCsi(source, index + 2)
        if (end === -1) break // незакрытая CSI — до конца текста
        if (source.charCodeAt(end - 1) === 0x6d /* m */) {
          style = applySgr(style, source.slice(index + 2, end - 1))
        }
        index = end
        continue
      }
      if (next === 0x5d /* ] */) {
        index = skipStringSequence(source, index + 2)
        continue
      }
      if (next === 0x50 || next === 0x58 || next === 0x5e || next === 0x5f) {
        index = skipStringSequence(source, index + 2)
        continue
      }
      if (next >= 0x28 && next <= 0x2f) {
        // Обозначение набора символов: ESC ( B и родственные — три байта.
        index += 3
        continue
      }
      index += 2 // ESC 7, ESC 8, ESC c, ESC = …
      continue
    }

    // C1-формы тех же последовательностей (8-битные терминалы).
    if (code === 0x9b /* CSI */) {
      const end = skipCsi(source, index + 1)
      if (end === -1) break
      if (source.charCodeAt(end - 1) === 0x6d) {
        style = applySgr(style, source.slice(index + 1, end - 1))
      }
      index = end
      continue
    }
    if (code === 0x9d /* OSC */) {
      index = skipStringSequence(source, index + 1)
      continue
    }

    if (code === 0x0a /* \n */) {
      line = { chars: [], styles: [] }
      lines.push(line)
      col = 0
      index += 1
      continue
    }
    if (code === 0x0d /* \r */) {
      // Возврат к началу строки: следующие символы перезаписывают её.
      col = 0
      index += 1
      continue
    }
    if (code === 0x08 /* \b */) {
      if (col > 0) col -= 1
      index += 1
      continue
    }
    if ((code < 0x20 && code !== 0x09 /* \t */) || code === 0x7f) {
      // Прочие управляющие (BEL, VT, FF, DEL…) в тексте не рисуются;
      // табуляция остаётся как есть — её ширину задаёт `tab-size` в `<pre>`.
      index += 1
      continue
    }

    // Обычный символ (в том числе `\t`) — в текущую колонку.
    if (col < line.chars.length) {
      line.chars[col] = source[index]!
      line.styles[col] = style
    } else {
      line.chars.push(source[index]!)
      line.styles.push(style)
    }
    col += 1
    index += 1
  }

  return { lines: lines.map(lineToTokens), clipped }
}

/**
 * Плоский текст без ANSI-кодов и управляющих последовательностей.
 *
 * Семантика та же, что у отображения (`\r`/`\b` перезаписывают), поэтому
 * скопированный текст совпадает с увиденным. Потолок не применяется: функция
 * используется и для тестов, где важен весь вход.
 */
export function stripAnsiText(text: string): string {
  const { lines } = parseAnsi(text, { maxChars: Number.POSITIVE_INFINITY })
  return lines.map((tokens) => tokens.map((token) => token.text).join('')).join('\n')
}
