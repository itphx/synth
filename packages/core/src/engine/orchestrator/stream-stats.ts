/**
 * Измеримость стриминга: нумерация и тайминги чанков (T14, dogfooding).
 *
 * Пользователь наблюдает «стриминг продолжается после ответа провайдера» —
 * понять, где задержка (сервер или клиент), можно только по времени. Поэтому
 * каждое событие `stream.chunk` несёт аддитивные `seq` (номер чанка в стриме,
 * с 1) и `t_ms` (мс от старта стрима), а `stream.done` — сводку `chunks`/
 * `first_chunk_ms`/`last_chunk_ms` (и `content_chars` — длина финального текста).
 *
 * Счётчик живёт в области одного хода (`_processMessage`), поэтому `seq`
 * сквозной по итерациям Tool Use, а не сбрасывается на каждой итерации: в UI
 * это один стрим (`stream_id`). Старые клиенты поля игнорируют.
 */
export interface StreamTimingSnapshot {
  /** Число опубликованных `stream.chunk` за стрим. */
  chunks: number;
  /** Время первого чанка от старта стрима (мс); нет чанков — поля нет. */
  firstChunkMs?: number;
  /** Время последнего чанка от старта стрима (мс); нет чанков — поля нет. */
  lastChunkMs?: number;
}

/** Накопитель таймингов чанков одного стрима. */
export class StreamTiming {
  private _seq = 0;
  private _firstMs: number | undefined;
  private _lastMs: number | undefined;

  constructor(private readonly _startedAt: number = Date.now()) {}

  /** Отметить очередной опубликованный чанк: `{seq, t_ms}` для payload. */
  next(now: number = Date.now()): { seq: number; t_ms: number } {
    const tMs = Math.max(0, now - this._startedAt);
    this._seq += 1;
    if (this._firstMs === undefined) this._firstMs = tMs;
    this._lastMs = tMs;
    return { seq: this._seq, t_ms: tMs };
  }

  /** Сводка для `stream.done` (аддитивные поля). */
  snapshot(): StreamTimingSnapshot {
    return {
      chunks: this._seq,
      ...(this._firstMs !== undefined ? { firstChunkMs: this._firstMs } : {}),
      ...(this._lastMs !== undefined ? { lastChunkMs: this._lastMs } : {}),
    };
  }
}
