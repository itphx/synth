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

import type { LivePart, MessageData } from '@/stores/chatStore'
import { buildPartsView } from '@/lib/messageParts'
import { markdownToPlain } from '@/lib/markdown/plain'

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

/**
 * Markdown → текст без разметки.
 *
 * Реализация — в `lib/markdown/plain.ts` (единственная на пакет: тот же разбор
 * используется для plain-превью свёрнутых строк, PROP-054).
 */
export function markdownToPlainText(markdown: string): string {
  return markdownToPlain(markdown)
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
