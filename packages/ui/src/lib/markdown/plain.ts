// Markdown → текст без разметки (PROP-054, волна 1).
//
// Каноническая реализация (единственная в пакете): разбор — `marked.lexer`,
// текст собирается **из токенов**, HTML не строится и в DOM не вставляется.
// Поэтому XSS невозможен (в отличие от `dangerouslySetInnerHTML`) и стоимость
// линейна от размера текста — в правой панели свёрнутые строки рендерятся
// десятками штук.
//
// До переноса сюда жил в `lib/messageCopy.ts` (копирование сообщений чата) —
// тот же разбор, одна реализация на оба потребителя.

import { marked } from 'marked'

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

/**
 * Markdown → текст без разметки (без DOM и без `dangerouslySetInnerHTML`).
 *
 * Используется для свёрнутых превью в правой панели (PROP-054): вместо
 * готового HTML показывается одна строка текста. Хвостовые пустые строки
 * срезаются, лишние переводы строк схлопываются.
 */
export function markdownToPlain(markdown: string): string {
  if (!markdown) return ''
  const tokens = marked.lexer(markdown) as unknown as AnyToken[]
  return blockText(tokens)
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()
}

/**
 * Обрезать plain-текст до превью: `maxLength` символов + многоточие.
 * Пустое значение — пустая строка (без «…»).
 */
export function clipPlainText(text: string, maxLength?: number): string {
  if (!maxLength || maxLength <= 0) return text
  if (text.length <= maxLength) return text
  return `${text.slice(0, maxLength).trimEnd()}…`
}
