/**
 * Кольцевой буфер вывода терминала (дизайн §3).
 *
 * ## Устройство
 *
 * - **Ёмкость** — 512 КиБ на терминал (`ringBufferBytes`), **сегменты** по 8 КиБ
 *   (`ringSegmentBytes`);
 * - сегмент — это страница: кусок вывода, который удерживается/вытесняется
 *   целиком (вытеснение — сдвиг массива, без копирования строк);
 * - внутри сегмента лежат **фрагменты** (`TerminalOutputChunk`) — каждый со
 *   своим монотонным `seq`. По `seq` клиент догоняет вывод (`?since=`).
 *
 * ## Почему `seq` у фрагмента, а не у «порции вывода»
 *
 * Один вызов `append` может быть больше сегмента (например, пришёл большой
 * кусок после долгого простоя). Он режется на фрагменты по границам сегмента,
 * и каждый получает свой `seq`: тогда `since(seq)` отдаёт **целые** фрагменты,
 * а не «хвост» чужой порции (клиент не получает обрезанный кадр).
 *
 * ## UTF-8-safe
 *
 * Границы фрагментов и сегментов — **всегда** по границе кодовой точки:
 * суррогатная пара (эмодзи) и многобайтные символы (кириллица) не рвутся
 * ни при наполнении сегмента, ни при вытеснении. Там, где вытеснить всё
 * равно нужно (единственный оставшийся сегмент больше ёмкости), сохраняется
 * **выровненный суффикс** — хвост, обрезанный по границе кодовой точки, с
 * новым `seq` (номер остаётся монотонным, клиент видит «хвост» как новый
 * фрагмент и догоняет его по `since`).
 */
import type { TerminalOutputChunk, TerminalOutputSnapshot } from './types.js';

/** Дефолтная ёмкость кольцевого буфера вывода, байт (512 КиБ). */
export const DEFAULT_TERMINAL_RING_BYTES = 512 * 1024;

/** Дефолтный размер сегмента кольцевого буфера, байт (8 КиБ). */
export const DEFAULT_TERMINAL_RING_SEGMENT_BYTES = 8 * 1024;

/** Сегмент кольцевого буфера: страница удерживаемого вывода. */
interface RingSegment {
  /** Фрагменты сегмента (по порядку). */
  pieces: TerminalOutputChunk[];
  /** Объём сегмента, байт. */
  bytes: number;
}

/**
 * Разрезать текст на части по границам кодовых точек, каждая — не длиннее
 * `maxBytes` байт в UTF-8.
 *
 * `for (const ch of text)` идёт по **кодовым точкам**: суррогатная пара
 * (эмодзи) остаётся целой, кириллица (2 байта) не делится пополам.
 */
export function splitByUtf8Bytes(text: string, maxBytes: number): string[] {
  if (text === '') return [];
  const limit = Math.max(1, Math.floor(maxBytes));
  const parts: string[] = [];
  let current = '';
  let currentBytes = 0;
  for (const ch of text) {
    const size = Buffer.byteLength(ch, 'utf8');
    if (currentBytes + size > limit && current !== '') {
      parts.push(current);
      current = '';
      currentBytes = 0;
    }
    current += ch;
    currentBytes += size;
  }
  if (current !== '') parts.push(current);
  return parts;
}

/**
 * Суффикс текста, помещающийся в `maxBytes` байт UTF-8, обрезанный **по
 * границе кодовой точки**.
 *
 * Используется при вытеснении: хвост выравнивается, а «середина» символа не
 * остаётся в буфере (иначе клиент получил бы битый UTF-8).
 */
export function utf8AlignedSuffix(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  const points = Array.from(text);
  let bytes = 0;
  let start = points.length;
  for (let i = points.length - 1; i >= 0; i -= 1) {
    const size = Buffer.byteLength(points[i]!, 'utf8');
    if (bytes + size > maxBytes) break;
    bytes += size;
    start = i;
  }
  return points.slice(start).join('');
}

/** Опции кольцевого буфера. */
export interface TerminalRingBufferOptions {
  /** Ёмкость, байт (по умолчанию 512 КиБ). */
  maxBytes?: number;
  /** Размер сегмента, байт (по умолчанию 8 КиБ). */
  segmentBytes?: number;
}

/**
 * Кольцевой буфер вывода терминала.
 *
 * Наружу — `append`/`since`/`snapshot`; внутреннее устройство (сегменты) —
 * деталь реализации.
 */
export class TerminalRingBuffer {
  private readonly _maxBytes: number;
  private readonly _segmentBytes: number;
  private readonly _segments: RingSegment[] = [];
  private _bytes = 0;
  private _droppedBytes = 0;
  private _seq = 0;

  constructor(options: TerminalRingBufferOptions = {}) {
    this._maxBytes = Math.max(1, Math.floor(options.maxBytes ?? DEFAULT_TERMINAL_RING_BYTES));
    this._segmentBytes = Math.max(
      1,
      Math.floor(options.segmentBytes ?? DEFAULT_TERMINAL_RING_SEGMENT_BYTES),
    );
  }

  /** Ёмкость буфера, байт. */
  get maxBytes(): number {
    return this._maxBytes;
  }

  /** Размер сегмента, байт. */
  get segmentBytes(): number {
    return this._segmentBytes;
  }

  /** Текущий объём удерживаемого вывода, байт. */
  get byteLength(): number {
    return this._bytes;
  }

  /** Номер последнего выданного фрагмента (`0` — ещё ничего не записывалось). */
  get lastSeq(): number {
    return this._seq;
  }

  /** Номер самого старого удерживаемого фрагмента (`0` — буфер пуст). */
  get firstSeq(): number {
    const segment = this._segments[0];
    const piece = segment?.pieces[0];
    return piece ? piece.seq : 0;
  }

  /** Сколько байт вывода вытеснено из буфера (клиент их уже не увидит). */
  get droppedBytes(): number {
    return this._droppedBytes;
  }

  /**
   * Записать вывод.
   *
   * Возвращает созданные фрагменты (с их `seq`) — их же сервис доставляет
   * подписчикам, чтобы номер и содержимое не расходились.
   */
  append(data: string): TerminalOutputChunk[] {
    if (data === '') return [];
    const pieces: TerminalOutputChunk[] = [];
    for (const part of splitByUtf8Bytes(data, this._segmentBytes)) {
      const piece: TerminalOutputChunk = {
        seq: ++this._seq,
        data: part,
        bytes: Buffer.byteLength(part, 'utf8'),
      };
      this._push(piece);
      pieces.push(piece);
    }
    this._trim();
    return pieces;
  }

  /** Фрагменты с `seq > since` (replay для догоняющего клиента). */
  since(seq: number): TerminalOutputChunk[] {
    const result: TerminalOutputChunk[] = [];
    for (const segment of this._segments) {
      for (const piece of segment.pieces) {
        if (piece.seq > seq) result.push(piece);
      }
    }
    return result;
  }

  /** Снимок буфера (для `GET /terminals/:id/output`). */
  snapshot(): TerminalOutputSnapshot {
    const chunks: TerminalOutputChunk[] = [];
    for (const segment of this._segments) {
      for (const piece of segment.pieces) {
        chunks.push(piece);
      }
    }
    return {
      chunks,
      totalBytes: this._bytes,
      droppedBytes: this._droppedBytes,
      firstSeq: chunks.length > 0 ? chunks[0]!.seq : 0,
      lastSeq: this._seq,
    };
  }

  /** Положить фрагмент в текущий сегмент (или открыть новый). */
  private _push(piece: TerminalOutputChunk): void {
    const last = this._segments[this._segments.length - 1];
    if (last && last.bytes + piece.bytes <= this._segmentBytes) {
      last.pieces.push(piece);
      last.bytes += piece.bytes;
    } else {
      this._segments.push({ pieces: [piece], bytes: piece.bytes });
    }
    this._bytes += piece.bytes;
  }

  /**
   * Вытеснить старые данные, пока объём не уложится в ёмкость.
   *
   * Вытесняются **целые сегменты** (дёшево, без копирования строк): буфер
   * может превысить ёмкость меньше чем на один сегмент — это осознанный
   * компромисс (кратность вытеснения ≤ `segmentBytes`).
   */
  private _trim(): void {
    while (this._bytes > this._maxBytes && this._segments.length > 1) {
      const segment = this._segments.shift();
      if (!segment) break;
      this._bytes -= segment.bytes;
      this._droppedBytes += segment.bytes;
    }
    if (this._bytes <= this._maxBytes) return;

    // Остался единственный сегмент, и он больше ёмкости (ёмкость меньше
    // сегмента): сохраняем выровненный суффикс с новым `seq`.
    const segment = this._segments[0];
    if (!segment) return;
    const text = segment.pieces.map((piece) => piece.data).join('');
    const suffix = utf8AlignedSuffix(text, this._maxBytes);
    const suffixBytes = Buffer.byteLength(suffix, 'utf8');
    const dropped = segment.bytes - suffixBytes;
    if (suffix === '') {
      this._segments.shift();
      this._bytes -= segment.bytes;
      this._droppedBytes += segment.bytes;
      return;
    }
    this._segments[0] = {
      pieces: [{ seq: ++this._seq, data: suffix, bytes: suffixBytes }],
      bytes: suffixBytes,
    };
    this._bytes -= dropped;
    this._droppedBytes += dropped;
  }
}
