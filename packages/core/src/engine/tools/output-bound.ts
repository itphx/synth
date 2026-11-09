/**
 * Общий предел вывода инструментов (`tools.outputMaxLines`/`tools.outputMaxBytes`).
 *
 * Единая точка усечения результата тула перед тем, как он уйдёт в историю и
 * в контекст модели: результат длиннее лимита режется по строкам и по байтам
 * (срабатывает более жёсткий предел), а в конец добавляется пояснение, сколько
 * строк показано из скольких и как дочитать остальное.
 *
 * Модуль чистый (без состояния): те же лимиты применяет `executeToolDef`
 * (`engine/tools/tool-execution.ts`) — единственный chokepoint вызова тулов.
 */

import { t as sm } from '../system-messages.js';

/** Пределы вывода тула (строки/байты). */
export interface ToolOutputLimits {
  /** Максимум строк в результате. */
  maxLines: number;
  /** Максимум байт в результате (UTF-8). */
  maxBytes: number;
}

/** Результат усечения вывода тула. */
export interface BoundedToolOutput {
  /** Итоговый текст (с маркером усечения, если вывод обрезан). */
  content: string;
  /** Признак усечения. */
  truncated: boolean;
  /** Сколько строк показано. */
  shownLines: number;
  /** Сколько строк было в исходном выводе. */
  totalLines: number;
}

/** Опции усечения вывода тула. */
export interface BoundToolOutputOptions {
  /**
   * Маркер усечения самого тула (текст, который тул положил в конец своего
   * вывода и продублировал в `metadata.truncationNote`).
   *
   * Общий бунд режет вывод по голове — без этой подсказки маркер тула
   * потерялся бы, и модель не увидела бы объяснение самого тула (например
   * «показано 40 из 46 совпадений»). Маркер возвращается в конец усечённого
   * вывода; если бунд его не срезал — возвращается как есть (дубля не будет).
   *
   * Список — когда тул оставил несколько маркеров (например усечение вывода
   * и «скрыто совпадений в исключённых путях»): оба должны дойти до модели.
   */
  tailNote?: string | string[];
}

/** Байтовая длина строки в UTF-8. */
function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/**
 * Предельный префикс строки, который влезает в бюджет байт.
 *
 * Обрезка идёт по code point'ам (не по code unit'ам) — многобайтовый символ
 * не разрезается пополам.
 */
function byteSafePrefix(line: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  let bytes = 0;
  let out = '';
  for (const char of line) {
    const size = byteLength(char);
    if (bytes + size > maxBytes) break;
    bytes += size;
    out += char;
  }
  return out;
}

/**
 * Разбиение вывода на строки.
 *
 * Висящий перевод строки в конце не считается отдельной строкой — так же,
 * как в `read_file` (счётчик строк файла). Пустой вывод — одна (пустая) строка.
 */
function splitLines(content: string): string[] {
  const parts = content.split('\n');
  if (parts.length > 1 && parts[parts.length - 1] === '') return parts.slice(0, -1);
  return parts;
}

/**
 * Усечение вывода тула по лимитам строк и байт.
 *
 * Считаются **все** строки исходного вывода (`totalLines`), в конец усечённого
 * текста добавляется маркер `tool.output_bounded` с числом показанных строк.
 *
 * `opts.tailNote` — маркер усечения самого тула: он возвращается в конец
 * усечённого вывода (между выводом и общим маркером), чтобы объяснение тула
 * не потерялось. Если бунд маркер не срезал — возвращается как есть, без дубля.
 */
export function boundToolOutput(
  content: string,
  limits: ToolOutputLimits,
  opts: BoundToolOutputOptions = {},
): BoundedToolOutput {
  const maxLines = Math.max(1, Math.floor(limits.maxLines));
  const maxBytes = Math.max(1, Math.floor(limits.maxBytes));

  const lines = splitLines(content);
  const totalLines = lines.length;

  // Быстрый путь: вывод влезает и по строкам, и по байтам.
  if (totalLines <= maxLines && byteLength(content) <= maxBytes) {
    return { content, truncated: false, shownLines: totalLines, totalLines };
  }

  // Предел по строкам: оставляем первые `maxLines` строк.
  const lineLimit = Math.min(maxLines, totalLines);

  // Предел по байтам: идём по строкам, пока хватает бюджета ('\n' — 1 байт).
  let used = 0;
  let byteLimit = 0;
  for (let i = 0; i < lineLimit; i++) {
    const size = byteLength(lines[i]!) + (i > 0 ? 1 : 0);
    if (used + size > maxBytes) break;
    used += size;
    byteLimit = i + 1;
  }

  let kept: string;
  let shownLines: number;
  if (byteLimit === 0) {
    // Даже первая строка не помещается в бюджет — показываем её префикс.
    kept = byteSafePrefix(lines[0] ?? '', maxBytes);
    shownLines = kept.length > 0 ? 1 : 0;
  } else {
    kept = lines.slice(0, byteLimit).join('\n');
    shownLines = byteLimit;
  }

  const marker = sm('tool.output_bounded', {
    shown: String(shownLines),
    total: String(totalLines),
  });

  // Маркер тула возвращаем, только если бунд его не оставил в усечённой части.
  const notes = (Array.isArray(opts.tailNote) ? opts.tailNote : [opts.tailNote]).filter(
    (note): note is string => typeof note === 'string' && note !== '',
  );
  const missing = notes.filter((note) => !kept.includes(note));
  const tail = missing.length > 0 ? missing.join('\n\n') : undefined;

  return {
    content: tail !== undefined ? `${kept}\n\n${tail}\n\n${marker}` : `${kept}\n\n${marker}`,
    truncated: true,
    shownLines,
    totalLines,
  };
}
