/**
 * М2: чанкер текста (markdown-aware) — движок ванильного RAG.
 *
 * Нарезка корпуса на чанки (единица эмбеддинга и единица выдачи поиска).
 * Правила (docs/MEMORY.md §2.3, решения М2 зафиксированы):
 * - режем **по структуре**: заголовок markdown — начало нового блока, пустая
 *   строка — конец абзаца; длинный блок режется по `chunkChars` с
 *   перекрытием `chunkOverlap`;
 * - **детерминированно**: одинаковый вход → одинаковые чанки и границы строк
 *   (иначе дрожит prompt-cache, ADR-070, и индекс не воспроизводим);
 * - **по границам строк**: текст режется между строками, а не посреди строки
 *   (если строка сама длиннее лимита — она остаётся целой);
 * - версия чанкера (`chunkerVersion`) входит в фингерпринт индекса: смена
 *   нарезки меняет вектора, значит — индекс становится `stale`.
 *
 * Границы строк — **1-based** (строка 1 — первая строка файла): так их видит
 * редактор, и в выдаче модели они читаются как «файл, строки 12–40».
 */

/** Версия чанкера — часть фингерпринта индекса (docs/MEMORY.md §5.2). */
export const CHUNKER_VERSION = '1';

/** Параметры нарезки. */
export interface ChunkOptions {
  /** Максимальный размер чанка в символах. */
  chunkChars: number;
  /** Перекрытие соседних чанков в символах. */
  chunkOverlap: number;
}

/** Чанк текста. */
export interface TextChunk {
  /** Текст чанка (то, что уходит в эмбеддинг). */
  text: string;
  /** Первая строка чанка в исходном тексте (1-based). */
  startLine: number;
  /** Последняя строка чанка в исходном тексте (1-based). */
  endLine: number;
  /** Порядковый номер чанка в документе (0-based). */
  ordinal: number;
}

/** Заголовок markdown (`#`…`######`) в начале строки. */
const HEADING_RE = /^\s{0,3}#{1,6}(\s|$)/;

/** Блок текста (абзац или раздел): строки + номер первой строки. */
interface TextBlock {
  lines: string[];
  /** Номер первой строки блока (1-based). */
  startLine: number;
}

/** Привести положительное число к целому; нечисловое — дефолт. */
function positiveInt(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

/**
 * Нарезать текст на чанки.
 *
 * Пустой текст → пустой массив (индекс без чанков — не ошибка).
 */
export function chunkText(text: string, options: ChunkOptions): TextChunk[] {
  const chunkChars = positiveInt(options.chunkChars, 1200);
  const chunkOverlap = Math.min(
    Math.max(0, positiveInt(options.chunkOverlap, 0)),
    Math.max(0, chunkChars - 1),
  );
  const source = text ?? '';
  if (source.trim().length === 0) return [];

  const blocks = splitBlocks(source.split(/\r?\n/));
  const chunks: TextChunk[] = [];
  for (const block of blocks) {
    for (const piece of splitBlock(block, chunkChars, chunkOverlap)) {
      chunks.push({ ...piece, ordinal: chunks.length });
    }
  }
  return chunks;
}

/**
 * Разбить строки на блоки: заголовок — начало блока, пустая строка — конец.
 *
 * Пустые строки в блок не попадают (иначе чанк начинался бы с пустой строки),
 * но структура (границы абзацев) сохраняется.
 */
function splitBlocks(lines: readonly string[]): TextBlock[] {
  const blocks: TextBlock[] = [];
  let current: string[] = [];
  let currentStart = 0;

  for (const [offset, line] of lines.entries()) {
    const lineNo = offset + 1;
    if (line.trim().length === 0) {
      if (current.length > 0) {
        blocks.push({ lines: current, startLine: currentStart });
        current = [];
      }
      continue;
    }
    if (HEADING_RE.test(line) && current.length > 0) {
      blocks.push({ lines: current, startLine: currentStart });
      current = [];
    }
    if (current.length === 0) currentStart = lineNo;
    current.push(line);
  }
  if (current.length > 0) blocks.push({ lines: current, startLine: currentStart });
  return blocks;
}

/**
 * Разрезать блок на части по `chunkChars` с перекрытием `chunkOverlap`.
 *
 * Режем **по строкам**: строка не разрывается, даже если она длиннее лимита
 * (иначе в чанке окажется обрывок кода). Перекрытие — хвост предыдущей
 * части; прогресс гарантирован (новая часть всегда содержит хотя бы одну
 * новую строку).
 */
function splitBlock(
  block: TextBlock,
  chunkChars: number,
  chunkOverlap: number,
): Array<Omit<TextChunk, 'ordinal'>> {
  const pieces: Array<Omit<TextChunk, 'ordinal'>> = [];
  const lines = block.lines;
  let from = 0;

  while (from < lines.length) {
    const piece: string[] = [];
    let length = 0;
    let to = from;
    while (to < lines.length) {
      const addition = piece.length === 0 ? (lines[to] ?? '').length : (lines[to] ?? '').length + 1;
      if (piece.length > 0 && length + addition > chunkChars) break;
      piece.push(lines[to] ?? '');
      length += addition;
      to += 1;
      if (length >= chunkChars) break;
    }
    pieces.push({
      text: piece.join('\n'),
      startLine: block.startLine + from,
      endLine: block.startLine + to - 1,
    });
    if (to >= lines.length) break;
    from = to - overlapLines(piece, chunkOverlap);
  }
  return pieces;
}

/**
 * Сколько строк хвоста части уходит в перекрытие следующей.
 *
 * Ограничения: хвост должен влезать в `chunkOverlap` и не может съесть всю
 * часть (иначе цикл не продвигается).
 */
function overlapLines(piece: readonly string[], chunkOverlap: number): number {
  if (chunkOverlap <= 0 || piece.length === 0) return 0;
  let total = 0;
  let count = 0;
  for (let i = piece.length - 1; i >= 0; i -= 1) {
    const line = piece[i] ?? '';
    const addition = count === 0 ? line.length : line.length + 1;
    if (total + addition > chunkOverlap) break;
    total += addition;
    count += 1;
  }
  return Math.min(count, piece.length - 1);
}
