/**
 * ADR-126: подсветка ссылочных токенов в композере.
 *
 * Полноценный markdown-рендер здесь не нужен: подсвечиваем только то, что
 * имеет семантику ввода — `/команда`, `$скилл`, `#сниппет`, `@упоминание`
 * и `!скрипт`.
 * Правила совпадают с core-лексером (`engine/input-surface/parser.ts`):
 * начало слова, code-блоки и inline-code не трогаются, `$5`/`#123` — не токены.
 *
 * Возвращает части текста для прозрачного overlay под textarea; текст не
 * меняется — только размечается классами.
 */

export type ComposerTokenKind = 'command' | 'skill' | 'snippet' | 'mention' | 'script'

export interface ComposerHighlightPart {
  text: string
  kind?: ComposerTokenKind
}

const CLASS_NAME: Record<ComposerTokenKind, string> = {
  command: 'text-primary',
  skill: 'text-status-success',
  snippet: 'text-status-warning',
  mention: 'text-status-info',
  // `text-accent` — приглушённый песочный тон (светлая тема: почти фон), токен
  // в нём не читается; `text-status-success`/`text-status-warning` заняты `$`/`#`.
  script: 'text-status-caution',
}

export function composerTokenClass(kind: ComposerTokenKind): string {
  return CLASS_NAME[kind]
}

const WORD = /[\p{L}\p{N}_]/u
const SYMBOL_BODY = /[\p{L}\p{N}._-]/u
const LETTER = /\p{L}/u
const WHITESPACE = /\s/u
/**
 * ADR-126 §5: имя скрипта — `[a-z0-9][a-z0-9-]*` (как в реестре скриптов
 * core: `^[a-z0-9]+(-[a-z0-9]+)*$`).
 */
const SCRIPT_NAME_BODY = /[a-z0-9-]/u

/** Fenced-блок ```/~~~ и inline-code — внутри токены не подсвечиваются. */
function buildCodeMask(text: string): boolean[] {
  const mask = new Array<boolean>(text.length).fill(false)
  const fence = /^[ \t]{0,3}(`{3,}|~{3,})/
  let fenceChar = ''
  let fenceLen = 0
  let lineStart = 0

  while (lineStart <= text.length) {
    const nl = text.indexOf('\n', lineStart)
    const lineEnd = nl === -1 ? text.length : nl
    const match = fence.exec(text.slice(lineStart, lineEnd))
    if (match) {
      const marker = match[1] ?? ''
      if (!fenceChar) {
        fenceChar = marker[0] ?? ''
        fenceLen = marker.length
        mask.fill(true, lineStart, lineEnd)
      } else {
        mask.fill(true, lineStart, lineEnd)
        if ((marker[0] ?? '') === fenceChar && marker.length >= fenceLen) {
          fenceChar = ''
          fenceLen = 0
        }
      }
    } else if (fenceChar) {
      mask.fill(true, lineStart, lineEnd)
    }
    if (nl === -1) break
    lineStart = nl + 1
  }

  // Inline-code: прогон backtick'ов закрывается тем же числом.
  let i = 0
  while (i < text.length) {
    if (mask[i] || text[i] !== '`') {
      i++
      continue
    }
    let run = 0
    while (text[i + run] === '`') run++
    const close = text.indexOf('`'.repeat(run), i + run)
    if (close === -1) {
      i += run
      continue
    }
    mask.fill(true, i, close + run)
    i = close + run
  }
  return mask
}

function isWordStart(text: string, index: number): boolean {
  if (index === 0) return true
  const prev = text[index - 1] ?? ''
  return !WORD.test(prev)
}

function readSymbolToken(text: string, start: number): number | null {
  let end = start + 1
  while (end < text.length && SYMBOL_BODY.test(text[end] ?? '')) end++
  const label = text.slice(start + 1, end)
  if (!label || !LETTER.test(label[0] ?? '')) return null
  return end
}

function readMentionToken(text: string, start: number, mask: boolean[]): number | null {
  let end = start + 1
  while (end < text.length) {
    const char = text[end] ?? ''
    if (WHITESPACE.test(char) || char === '@' || char === '$' || char === '#' || char === '`') break
    if (mask[end]) break
    end++
  }
  return end > start + 1 ? end : null
}

/** Разметка текста композера на обычные и ссылочные части. */
export function highlightComposer(text: string): ComposerHighlightPart[] {
  if (!text) return []
  const mask = buildCodeMask(text)
  const parts: ComposerHighlightPart[] = []
  let plainStart = 0
  let i = 0
  // ADR-126: `/`-команда и `!`-скрипт распознаются только как первый
  // непробельный токен сообщения.
  const firstNonSpace = text.search(/\S/u)

  const pushPlain = (end: number) => {
    if (end > plainStart) parts.push({ text: text.slice(plainStart, end) })
  }

  while (i < text.length) {
    if (
      mask[i] ||
      (text[i] !== '/' && text[i] !== '$' && text[i] !== '#' && text[i] !== '@' && text[i] !== '!')
    ) {
      i++
      continue
    }
    if (!isWordStart(text, i)) {
      i++
      continue
    }

    let kind: ComposerTokenKind | null = null
    let end: number | null = null

    if (text[i] === '/') {
      // Команда — только первый непробельный символ сообщения.
      if (i === firstNonSpace) {
        let j = i + 1
        while (j < text.length && /[\p{L}\p{N}._-]/u.test(text[j] ?? '')) j++
        if (j > i + 1) {
          kind = 'command'
          end = j
        }
      }
    } else if (text[i] === '!') {
      // ADR-126 §5: `!name` — только первый непробельный токен сообщения;
      // имя — `[a-z0-9][a-z0-9-]*`. `!=`, `! ` и `!!` токеном не являются.
      if (i === firstNonSpace) {
        let j = i + 1
        while (j < text.length && SCRIPT_NAME_BODY.test(text[j] ?? '')) j++
        const name = text.slice(i + 1, j)
        if (name && /[a-z0-9]/.test(name[0] ?? '')) {
          kind = 'script'
          end = j
        }
      }
    } else if (text[i] === '$' || text[i] === '#') {
      if (text[i] === '#' && (text[i + 1] === '#' || WHITESPACE.test(text[i + 1] ?? ''))) {
        i++
        continue
      }
      const tokenEnd = readSymbolToken(text, i)
      if (tokenEnd) {
        kind = text[i] === '$' ? 'skill' : 'snippet'
        end = tokenEnd
      }
    } else {
      const tokenEnd = readMentionToken(text, i, mask)
      if (tokenEnd) {
        kind = 'mention'
        end = tokenEnd
      }
    }

    if (!kind || !end) {
      i++
      continue
    }
    pushPlain(i)
    parts.push({ text: text.slice(i, end), kind })
    i = end
    plainStart = end
  }
  pushPlain(text.length)
  return parts
}
