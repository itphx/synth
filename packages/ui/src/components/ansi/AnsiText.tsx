import React, { useMemo } from 'react'

import { parseAnsi, stripAnsiText, type AnsiToken } from '@/lib/ansi'

/**
 * Вывод с ANSI-последовательностями как inline-контент.
 *
 * Консольный вывод (логи фоновых прогонов, результаты `execute_shell`) приходит
 * с цветами: shell исполняется в PTY с `TERM=xterm-256color`, поэтому vitest,
 * git, pytest и прочие включают SGR. Компонент разбирает текст
 * (`lib/ansi.ts`) и рисует его спанами, а не сырым текстом с `□[32m`.
 *
 * Обёртку `<pre>` даёт вызывающий: компонент — inline-содержимое, чтобы не
 * ломать текущий скролл/автоскролл вкладок вывода.
 *
 * Цвета:
 * - 16 базовых — классами темы (`text-ansi-red`, `bg-ansi-bright-black`), поэтому
 *   светлая и тёмная темы читаются одинаково;
 * - 256/truecolor — инлайновым `style` (`rgb(...)`); HTML не собирается,
 *   `dangerouslySetInnerHTML` не используется.
 *
 * `colors=false` — плоский текст без единого раскрашенного спана (кнопка
 * «Цвета» в логах).
 */

/** Классы для 16 базовых цветов текста (SGR 30-37 / 90-97). */
const FG_CLASS: Record<string, string> = {
  black: 'text-ansi-black',
  red: 'text-ansi-red',
  green: 'text-ansi-green',
  yellow: 'text-ansi-yellow',
  blue: 'text-ansi-blue',
  magenta: 'text-ansi-magenta',
  cyan: 'text-ansi-cyan',
  white: 'text-ansi-white',
  'bright-black': 'text-ansi-bright-black',
  'bright-red': 'text-ansi-bright-red',
  'bright-green': 'text-ansi-bright-green',
  'bright-yellow': 'text-ansi-bright-yellow',
  'bright-blue': 'text-ansi-bright-blue',
  'bright-magenta': 'text-ansi-bright-magenta',
  'bright-cyan': 'text-ansi-bright-cyan',
  'bright-white': 'text-ansi-bright-white',
}

/** Классы для 16 базовых цветов фона (SGR 40-47 / 100-107). */
const BG_CLASS: Record<string, string> = {
  black: 'bg-ansi-black',
  red: 'bg-ansi-red',
  green: 'bg-ansi-green',
  yellow: 'bg-ansi-yellow',
  blue: 'bg-ansi-blue',
  magenta: 'bg-ansi-magenta',
  cyan: 'bg-ansi-cyan',
  white: 'bg-ansi-white',
  'bright-black': 'bg-ansi-bright-black',
  'bright-red': 'bg-ansi-bright-red',
  'bright-green': 'bg-ansi-bright-green',
  'bright-yellow': 'bg-ansi-bright-yellow',
  'bright-blue': 'bg-ansi-bright-blue',
  'bright-magenta': 'bg-ansi-bright-magenta',
  'bright-cyan': 'bg-ansi-bright-cyan',
  'bright-white': 'bg-ansi-bright-white',
}

/** Классы начертаний токена. */
function tokenClassName(token: AnsiToken): string {
  const classes: string[] = []
  if (token.bold) classes.push('font-bold')
  if (token.dim) classes.push('opacity-60')
  if (token.italic) classes.push('italic')
  if (token.underline) classes.push('underline')
  if (token.fg !== undefined && FG_CLASS[token.fg] !== undefined) classes.push(FG_CLASS[token.fg])
  if (token.bg !== undefined && BG_CLASS[token.bg] !== undefined) classes.push(BG_CLASS[token.bg])
  return classes.join(' ')
}

/** Инлайновый стиль для 256/truecolor (всё, что пришло как `rgb(...)`). */
function tokenStyle(token: AnsiToken): React.CSSProperties | undefined {
  const style: React.CSSProperties = {}
  if (token.fg !== undefined && token.fg.startsWith('rgb(')) style.color = token.fg
  if (token.bg !== undefined && token.bg.startsWith('rgb(')) style.backgroundColor = token.bg
  return Object.keys(style).length > 0 ? style : undefined
}

export interface AnsiTextProps {
  /** Текст с ANSI-последовательностями (как пришёл из лога). */
  text: string
  /** Раскрашивать (`true`) или отдать плоский текст (`false`). */
  colors: boolean
  className?: string
  testId?: string
  /** Потолок разбора; по умолчанию — `DEFAULT_MAX_ANSI_CHARS`. */
  maxChars?: number
}

export function AnsiText({ text, colors, className, testId, maxChars }: AnsiTextProps) {
  const content = useMemo<React.ReactNode>(() => {
    if (!colors) return stripAnsiText(text)

    const { lines } = parseAnsi(text, maxChars === undefined ? {} : { maxChars })
    const nodes: React.ReactNode[] = []
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      if (lineIndex > 0) nodes.push('\n')
      const tokens = lines[lineIndex] ?? []
      for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex += 1) {
        const token = tokens[tokenIndex]!
        const tokenClass = tokenClassName(token)
        const style = tokenStyle(token)
        // Оформления нет — обычный текст, лишний спан не нужен.
        if (tokenClass === '' && style === undefined) {
          nodes.push(token.text)
          continue
        }
        nodes.push(
          <span key={`${lineIndex}-${tokenIndex}`} className={tokenClass || undefined} style={style}>
            {token.text}
          </span>,
        )
      }
    }
    return nodes
  }, [text, colors, maxChars])

  // Без className/testId обёртка не нужна: компонент — inline-содержимое.
  if (className === undefined && testId === undefined) return <>{content}</>
  return (
    <span className={className} data-testid={testId}>
      {content}
    </span>
  )
}
