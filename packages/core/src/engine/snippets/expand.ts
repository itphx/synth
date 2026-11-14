import { parseInput } from '../input-surface/parser.js';
import { resolveSnippet, resolveUntrustedSnippet } from './registry.js';
import { MAX_SNIPPET_BYTES, MAX_SNIPPET_EXPANSIONS } from './types.js';
import type { SnippetDiagnostic } from './types.js';
import type { SnippetIndex } from './registry.js';

/**
 * ADR-126 §4: раскрытие `#`-сниппетов в пользовательском тексте.
 *
 * Правила:
 *
 * - **один проход, без рекурсии**: `#` внутри тела сниппета остаётся текстом
 *   (решение владельца) — тело подставляется как есть и не разбирается заново;
 * - токены внутри code-блоков не трогаются: их отсекает общий лексер
 *   `engine/input-surface/parser.ts` (`parseInput(text).snippets`);
 * - неизвестный `#token` и недоверенный сниппет остаются в тексте как есть;
 * - лимиты: не более 15 раскрытий и 64 КБ на сообщение; превышение — оставшийся
 *   токен не раскрывается (в тексте остаётся `#token`).
 */

export interface ExpandSnippetsOptions {
  /** Индекс раскрытия (реестр: канон + алиасы). */
  index: SnippetIndex;
  /** Предел числа раскрытий (по умолчанию 15). */
  maxExpansions?: number;
  /** Предел размера сообщения после раскрытия в байтах (по умолчанию 64 КБ). */
  maxBytes?: number;
}

export interface ExpandSnippetsResult {
  /** Текст после раскрытия (без изменений, если раскрывать было нечего). */
  text: string;
  /** Имена раскрытых сниппетов (канонические) в порядке появления в тексте. */
  applied: string[];
  /** Диагностика (недоверенный сниппет, исчерпанный лимит). */
  diagnostics: SnippetDiagnostic[];
}

interface Replacement {
  start: number;
  end: number;
  body: string;
  name: string;
}

/**
 * Раскрывает сниппеты в тексте. Чистая функция: без I/O и мутаций.
 */
export function expandSnippetMentions(
  text: string,
  opts: ExpandSnippetsOptions,
): ExpandSnippetsResult {
  const diagnostics: SnippetDiagnostic[] = [];
  const applied: string[] = [];
  if (!text) return { text, applied, diagnostics };

  const maxExpansions = opts.maxExpansions ?? MAX_SNIPPET_EXPANSIONS;
  const maxBytes = opts.maxBytes ?? MAX_SNIPPET_BYTES;

  const mentions = parseInput(text).snippets;
  if (mentions.length === 0) return { text, applied, diagnostics };

  const replacements: Replacement[] = [];
  for (const mention of mentions) {
    const snippet = resolveSnippet(opts.index, mention.id);
    if (!snippet) {
      // Неизвестный токен — обычный текст (ошибка не блокирует отправку).
      // Недоверенный сниппет — тоже остаётся текстом, но с объяснением.
      const untrusted = resolveUntrustedSnippet(opts.index, mention.id);
      if (untrusted) {
        diagnostics.push({
          level: 'warning',
          code: 'untrusted',
          snippet: untrusted.name,
          path: untrusted.file,
          message: `сниппет "${untrusted.name}" недоверенный: не раскрывается`,
        });
      }
      continue;
    }
    if (!snippet.trusted) {
      diagnostics.push({
        level: 'warning',
        code: 'untrusted',
        snippet: snippet.name,
        path: snippet.file,
        message: `сниппет "${snippet.name}" недоверенный: не раскрывается`,
      });
      continue;
    }
    if (replacements.length >= maxExpansions) {
      diagnostics.push({
        level: 'warning',
        code: 'limit-exceeded',
        snippet: snippet.name,
        path: snippet.file,
        message: `лимит раскрытий сниппетов (${maxExpansions}) исчерпан: "${snippet.name}" оставлен как есть`,
      });
      continue;
    }
    replacements.push({
      start: mention.span.start,
      end: mention.span.end,
      body: snippet.body,
      name: snippet.name,
    });
  }

  // Раскрываем с конца: индексы более ранних спанов не смещаются.
  let result = text;
  let bytes = Buffer.byteLength(text, 'utf8');
  for (let index = replacements.length - 1; index >= 0; index--) {
    const replacement = replacements[index]!;
    const removed = Buffer.byteLength(text.slice(replacement.start, replacement.end), 'utf8');
    const added = Buffer.byteLength(replacement.body, 'utf8');
    if (bytes - removed + added > maxBytes) {
      diagnostics.push({
        level: 'warning',
        code: 'limit-exceeded',
        snippet: replacement.name,
        message: `лимит размера сообщения (${maxBytes} байт) исчерпан: "${replacement.name}" оставлен как есть`,
      });
      continue;
    }
    result = result.slice(0, replacement.start) + replacement.body + result.slice(replacement.end);
    bytes = bytes - removed + added;
    applied.unshift(replacement.name);
  }

  return { text: result, applied, diagnostics };
}
