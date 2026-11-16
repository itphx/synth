// terminalContext: блок контекста терминала для сообщения агенту (PROP-132, Ф4б).
//
// Вывод терминала **не уходит в LLM сам** — только явное действие человека:
// «Спросить агента» (док с автоконтекстом) или «Прикрепить вывод» (вставка
// блока в черновик композера).
//
// Два формата блока:
// - контекст дока «Спросить агента» — такой же, как у прочих служебных
//   блоков сообщений (`<system-state>`, `<process …>`):
//
//   <terminal_context terminal="<id>" cwd="<cwd>" shell="<shell>">
//   …последние N строк…
//   </terminal_context>
//
// - «Прикрепить вывод» — **формат `terminal_read`** (как у тула в ядре):
//   метаданные в открывающем маркере, закрывающий — `[CONTENT END]`:
//
//   [CONTENT terminal=<id> status=<status> bytes=<n> tail=<n> stripped=true]
//   …строки вывода…
//   [CONTENT END]
//
// Модуль чистый (без React и без xterm): берёт строки текстом/буфером и
// собирает блок. Так его можно проверить обычным тестом.

/** Сколько строк вывода терминала уходит в контекст по умолчанию. */
export const TERMINAL_CONTEXT_LINES = 50

/** Экранирование значения атрибута блока `<terminal_context>`. */
function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/**
 * Последние N строк текста.
 *
 * Хвост текста (пустая строка после последнего `\n`) не считается строкой
 * вывода — иначе в контекст уезжал бы лишний пустой элемент.
 */
export function tailLines(text: string, limit: number): string[] {
  if (limit <= 0) return []
  const lines = text.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines.slice(-limit)
}

/** Минимальный хвост буфера xterm (структурный тип — без зависимости от xterm). */
export interface TerminalBufferLike {
  buffer?: {
    active?: {
      length: number
      baseY: number
      getLine(index: number): { translateToString(trim?: boolean): string } | undefined
    }
  }
}

/**
 * Последние N строк буфера терминала.
 *
 * Пустые строки в начале хвоста (обычные пустые строки прокрутки) отбрасываются
 * — иначе контекст состоял бы из пустых строк вместо вывода.
 */
export function readTerminalBufferLines(
  term: TerminalBufferLike | null | undefined,
  limit: number,
): string[] {
  if (!term || limit <= 0) return []
  const buffer = term.buffer?.active
  if (!buffer) return []
  // `length` — число строк в буфере (прокрутка + текущая страница), значит
  // последняя строка — `length - 1`. `baseY` — индекс начала нижней страницы:
  // прибавлять его нельзя, иначе индексы уходят за конец буфера и контекст
  // оказывается пустым, как только есть прокрутка.
  const end = buffer.length
  const out: string[] = []
  for (let i = Math.max(0, end - limit); i < end; i++) {
    const line = buffer.getLine(i)
    if (!line) continue
    out.push(line.translateToString(true))
  }
  while (out.length > 0 && out[0] === '') out.shift()
  return out
}

/**
 * Блок `<terminal_context>` из вывода терминала.
 *
 * Строки вывода — уже готовые строки (хвост буфера или выделение); блок
 * собирается как есть, без дополнительного форматирования.
 */
export function buildTerminalContextBlock(input: {
  terminalId: string
  cwd?: string | null
  shell?: string | null
  lines: string[]
}): string {
  const attrs = [
    `terminal="${escapeAttr(input.terminalId)}"`,
    `cwd="${escapeAttr(input.cwd ?? '')}"`,
    `shell="${escapeAttr(input.shell ?? '')}"`,
  ].join(' ')
  const body = input.lines.join('\n')
  return `<terminal_context ${attrs}>\n${body}\n</terminal_context>`
}

/**
 * Значение атрибута маркера `[CONTENT …]`: без пробелов и `]`.
 *
 * Иначе значение закрыло бы маркер досрочно (или слиплось с соседним
 * атрибутом) — формат тот же, что у `terminal_read` в ядре.
 */
function sanitizeMarkerValue(value: string): string {
  return value.replace(/\s+/g, '').replace(/\]/g, '')
}

/**
 * Блок вывода терминала в формате `terminal_read`.
 *
 * Тот же контракт, что у тула `terminal_read` в ядре: метаданные — **в
 * открывающем маркере** (`terminal`/`status`/`bytes`/`tail`/`stripped`), тело —
 * строки вывода, закрывающий маркер — именно `[CONTENT END]`.
 *
 * ```
 * [CONTENT terminal=<id> status=<status> bytes=<utf8> tail=<lines> stripped=true]
 * <строки вывода>
 * [CONTENT END]
 * ```
 *
 * Пустой вывод — открывающий маркер и сразу `[CONTENT END]` (без пустой
 * строки между маркерами: иначе модель прочитает «пустую строку вывода» как
 * результат).
 */
export function buildTerminalReadBlock(input: {
  terminalId: string
  status: string
  lines: string[]
}): string {
  const body = input.lines.join('\n')
  const bytes = new TextEncoder().encode(body).length
  const open = [
    `[CONTENT terminal=${sanitizeMarkerValue(input.terminalId)}`,
    `status=${sanitizeMarkerValue(input.status)}`,
    `bytes=${bytes}`,
    `tail=${input.lines.length}`,
    'stripped=true]',
  ].join(' ')
  if (body === '') return `${open}\n[CONTENT END]`
  return `${open}\n${body}\n[CONTENT END]`
}

/**
 * Сокращение длинного пути: `…/<последние-сегменты>`.
 *
 * Полный путь в узкой правой панели не помещается — показываем хвост.
 */
export function shortenPath(path: string, maxSegments = 3): string {
  if (!path) return ''
  const parts = path.split('/').filter((part) => part !== '')
  if (parts.length <= maxSegments) return path
  return `…/${parts.slice(-maxSegments).join('/')}`
}
