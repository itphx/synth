// ADR-118: копирование сообщения — «то, что видно», а не legacy-`content`.
//
// Раньше кнопка «Копировать» писала `message.content`, который на сервере
// собирает `buildContentFromParts` (`packages/shared/src/utils/index.ts`):
// текстовые части через `'\n'` **плюс** `<reasoning>…</reasoning>`,
// `<tool_call …>…</tool_call>` и `<tool_result …>…</tool_result>`. На экране
// рассуждения и вызовы инструментов рисуются отдельными (свёрнутыми) блоками,
// а видимый текст — только части `type: 'text'`. Копирование `content` давало
// пользователю «не то, что он видит» и хвостовые переносы строк из дословного
// ответа модели (ядро их не нормализует).
//
// Поэтому источник копии — `buildPartsView` (тот же, что у рендера): текст
// видимых частей, без рассуждений и карточек инструментов, с обрезанным хвостом.

import { marked } from 'marked'
import type { LivePart, MessageData } from '@/stores/chatStore'
import { buildPartsView } from '@/lib/messageParts'

/** Режим копирования: исходный markdown видимого текста или он же без разметки. */
export type CopyMode = 'markdown' | 'plain'

/**
 * Служебные блоки ядра в legacy-`content` (`buildContentFromParts`): на экране
 * они нарисованы отдельными блоками/карточками и в копию попадать не должны.
 * Флаг `g` — все вхождения; `[\s\S]` вместо `.` — содержимое может быть любым.
 */
const KERNEL_BLOCK_PATTERNS: RegExp[] = [
  /<reasoning>[\s\S]*?<\/reasoning>/gi,
  /<tool_call\b[^>]*>[\s\S]*?<\/tool_call>/gi,
  /<tool_result\b[^>]*>[\s\S]*?<\/tool_result>/gi,
  /<session_reference\b[^>]*>[\s\S]*?<\/session_reference>/gi,
]

/** Вырезать служебные блоки ядра из legacy-`content`. */
export function stripKernelBlocks(text: string): string {
  let out = text
  for (const pattern of KERNEL_BLOCK_PATTERNS) out = out.replace(pattern, '')
  // Пустоты от вырезанных блоков схлопываем, значимые пустые строки внутри — нет.
  return out.replace(/\n{3,}/g, '\n\n').trimEnd()
}

/** Markdown видимого текста сообщения (без reasoning и вызовов инструментов). */
export function messageVisibleText(message: MessageData, liveParts?: LivePart[]): string {
  // Есть части — источник истины только они: рассуждения и карточки
  // инструментов на экране отдельные (и свёрнутые), в копию они не входят.
  // К тексту из частей стрип не применяется — пользователь мог сам написать
  // `<tool_result>` кодом/цитатой.
  const hasParts = (message.parts?.length ?? 0) > 0 || (liveParts?.length ?? 0) > 0
  if (!hasParts) {
    // История до ADR-118: другой формы, кроме legacy-`content`, нет — из него
    // вырезаем служебные блоки ядра (`buildContentFromParts`).
    return stripKernelBlocks(message.content ?? '')
  }
  const view = buildPartsView(message.parts, liveParts, { content: '' })
  // Только хвост: внутренние переводы строк — часть ответа.
  return view.text.trimEnd()
}

// --- минимальная форма токена marked (обход без зависимости от внутренних типов)

interface AnyToken {
  type: string
  raw?: string
  text?: string
  href?: string
  ordered?: boolean
  start?: number | ''
  tokens?: AnyToken[]
  items?: AnyToken[]
  header?: AnyToken[]
  rows?: AnyToken[][]
}

/** Сырой HTML → текст: простого вырезания тегов достаточно (копия, не рендер). */
function stripTags(value: string): string {
  return value.replace(/<[^>]*>/g, '')
}

/** Инлайн-токены (внутри абзаца, заголовка, элемента списка, ячейки таблицы). */
function inlineText(tokens: AnyToken[]): string {
  let out = ''
  for (const token of tokens) {
    switch (token.type) {
      case 'text':
      case 'escape':
        out += token.tokens && token.tokens.length > 0 ? inlineText(token.tokens) : (token.text ?? '')
        break
      case 'strong':
      case 'em':
      case 'del':
        out += token.tokens && token.tokens.length > 0 ? inlineText(token.tokens) : (token.text ?? '')
        break
      case 'codespan':
        out += token.text ?? ''
        break
      case 'br':
        out += '\n'
        break
      case 'link': {
        // Подпись ссылки; пустая подпись — сам адрес (иначе ссылка теряется).
        const label = token.tokens && token.tokens.length > 0 ? inlineText(token.tokens) : (token.text ?? '')
        out += label.trim() !== '' ? label : (token.href ?? '')
        break
      }
      case 'image':
        // Картинка в плейн-тексте — только alt (пусто — ничего).
        out += token.text ?? ''
        break
      case 'html':
        out += stripTags(token.text ?? '')
        break
      case 'space':
        out += ' '
        break
      default:
        // Неизвестный инлайн-токен: не падаем, берём текст/сырьё без тегов.
        out += token.text ?? stripTags(token.raw ?? '')
        break
    }
  }
  return out
}

/** Список: `- ` / `N. `, вложенность — отступом 2 пробела. */
function listText(token: AnyToken, depth: number): string {
  const ordered = token.ordered === true
  let n = typeof token.start === 'number' ? token.start : 1
  const pad = '  '.repeat(depth)
  const lines: string[] = []
  for (const item of token.items ?? []) {
    const marker = ordered ? `${n++}. ` : '- '
    const content: string[] = []
    const nested: string[] = []
    for (const child of item.tokens ?? []) {
      if (child.type === 'list') {
        nested.push(listText(child, depth + 1))
      } else if (child.type === 'space') {
        continue
      } else if (child.type === 'code') {
        content.push(child.text ?? '')
      } else if (child.tokens && child.tokens.length > 0) {
        content.push(inlineText(child.tokens))
      } else {
        content.push(child.text ?? '')
      }
    }
    const body = content.join(' ').replace(/[ \t]+/g, ' ').trim()
    lines.push(`${pad}${marker}${body}`)
    if (nested.length > 0) lines.push(nested.join('\n'))
  }
  return lines.join('\n')
}

/** Таблица: строки через `\t`, между строками `\n` (заголовок — тоже строка). */
function tableText(token: AnyToken): string {
  const rowText = (cells: AnyToken[]): string =>
    cells.map((cell) => inlineText(cell.tokens ?? []).trim() || (cell.text ?? '')).join('\t')
  const lines: string[] = []
  if (token.header && token.header.length > 0) lines.push(rowText(token.header))
  for (const row of token.rows ?? []) lines.push(rowText(row))
  return lines.join('\n')
}

/** Блочные токены верхнего уровня. */
function blockText(tokens: AnyToken[], depth = 0): string {
  const chunks: string[] = []
  for (const token of tokens) {
    switch (token.type) {
      case 'space':
        chunks.push('\n')
        break
      case 'hr':
        chunks.push('\n\n')
        break
      case 'paragraph':
      case 'heading':
        chunks.push(inlineText(token.tokens ?? []) || (token.text ?? ''), '\n\n')
        break
      case 'blockquote':
        chunks.push(blockText(token.tokens ?? [], depth).trim(), '\n\n')
        break
      case 'list':
        chunks.push(listText(token, depth), '\n\n')
        break
      case 'code':
        // Сам код, без ``` и без языка.
        chunks.push(token.text ?? '', '\n\n')
        break
      case 'table':
        chunks.push(tableText(token), '\n\n')
        break
      case 'html':
        chunks.push(stripTags(token.text ?? ''), '\n\n')
        break
      case 'text':
        chunks.push(
          token.tokens && token.tokens.length > 0 ? inlineText(token.tokens) : (token.text ?? token.raw ?? ''),
          '\n\n',
        )
        break
      case 'def':
        // Определение ссылки в тексте не показывается.
        break
      default:
        chunks.push(
          token.tokens && token.tokens.length > 0
            ? inlineText(token.tokens)
            : (token.text ?? stripTags(token.raw ?? '')),
          '\n\n',
        )
        break
    }
  }
  return chunks.join('')
}

/** Markdown → текст без разметки (marked.lexer, без новых зависимостей). */
export function markdownToPlainText(markdown: string): string {
  if (!markdown) return ''
  const tokens = marked.lexer(markdown) as unknown as AnyToken[]
  return blockText(tokens)
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()
}

/**
 * Записать видимый текст сообщения в буфер обмена.
 *
 * `false` — копировать нечего (пустой текст) или буфер недоступен: ошибка
 * глушится, как в копировании блока кода (`MarkdownContent.writeClipboard`).
 */
export async function copyMessageText(
  message: MessageData,
  mode: CopyMode,
  liveParts?: LivePart[],
): Promise<boolean> {
  const markdown = messageVisibleText(message, liveParts)
  const text = mode === 'plain' ? markdownToPlainText(markdown) : markdown
  if (!text) return false
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}
