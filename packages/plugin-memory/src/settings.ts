/**
 * М2: настройки плагина памяти (`plugins[<имя>].settings`, ADR-107).
 *
 * Единое место чтения и нормализации настроек: блоки промпта, тулы и движок
 * индекса читают **одни и те же** значения (иначе тул и блок разойдутся —
 * docs/MEMORY.md §3, «одна реализация recall»).
 *
 * Настройки М1 (`factsLimit`/`recallLimit`/`minScore`) плюс настройки М2
 * (чанкер, эмбеддинги, поиск, корпус). Значение вне диапазона → дефолт
 * (fail-soft: плохая настройка не должна ломать ход).
 */

/** Настройки плагина памяти (нормализованные). */
export interface MemoryPluginSettings {
  /** Сколько фактов показывать в блоке «project facts». */
  factsLimit: number;
  /** Сколько фактов показывать в блоке recall. */
  recallLimit: number;
  /** Порог keyword-скоринга для recall (0..1). */
  minScore: number;
  /** Сколько результатов отдавать из поиска по индексу. */
  topK: number;
  /** Сколько чанков одного индекса просматривать за поиск. */
  maxChunks: number;
  /** Максимальный размер чанка (символы). */
  chunkChars: number;
  /** Перекрытие соседних чанков (символы). */
  chunkOverlap: number;
  /** Максимальный размер файла корпуса (байты); больше — файл пропускается. */
  maxFileBytes: number;
  /** Glob-список исключений корпуса (пути относительно рабочего каталога). */
  exclude: string[];
  /** Модель эмбеддингов (пусто — модель инстанса, «instance-default»). */
  embeddingModel: string;
  /** TTL кэша «пробы» размерности вектора, мс (0 — без кэша). */
  dimensionProbeTtlMs: number;
}

/** Дефолт лимита фактов в блоке «project facts». */
export const DEFAULT_FACTS_LIMIT = 6;
/** Допустимый диапазон лимита фактов. */
export const MIN_FACTS_LIMIT = 1;
export const MAX_FACTS_LIMIT = 20;
/** Дефолт лимита recall. */
export const DEFAULT_RECALL_LIMIT = 5;
/** Допустимый диапазон лимита recall. */
export const MIN_RECALL_LIMIT = 1;
export const MAX_RECALL_LIMIT = 20;
/** Дефолт порога keyword-скоринга (recall). */
export const DEFAULT_MIN_SCORE = 0.34;
/** Дефолт числа результатов поиска по индексу. */
export const DEFAULT_TOP_K = 5;
/** Допустимый диапазон `topK`. */
export const MIN_TOP_K = 1;
export const MAX_TOP_K = 50;
/** Дефолт числа просматриваемых чанков за поиск. */
export const DEFAULT_MAX_CHUNKS = 2000;
/** Допустимый диапазон `maxChunks`. */
export const MIN_MAX_CHUNKS = 1;
export const MAX_MAX_CHUNKS = 20_000;
/** Дефолт размера чанка (символы) — docs/MEMORY.md §2.3. */
export const DEFAULT_CHUNK_CHARS = 1200;
/** Допустимый диапазон размера чанка. */
export const MIN_CHUNK_CHARS = 100;
export const MAX_CHUNK_CHARS = 8000;
/** Дефолт перекрытия чанков (символы) — docs/MEMORY.md §2.3. */
export const DEFAULT_CHUNK_OVERLAP = 200;
/** Допустимый диапазон перекрытия. */
export const MIN_CHUNK_OVERLAP = 0;
export const MAX_CHUNK_OVERLAP = 4000;
/** Дефолт лимита размера файла корпуса (байты). */
export const DEFAULT_MAX_FILE_BYTES = 512_000;
/** Допустимый диапазон лимита размера файла. */
export const MIN_MAX_FILE_BYTES = 1024;
export const MAX_MAX_FILE_BYTES = 20_000_000;
/** Дефолт TTL кэша «пробы» размерности вектора, мс. */
export const DEFAULT_DIMENSION_PROBE_TTL_MS = 30_000;

/** Привести число к диапазону; нечисловое значение — дефолт. */
export function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** Список строк из значения настройки (строка → один элемент). */
function stringList(value: unknown): string[] {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/**
 * Нормализовать настройки плагина из сырого снимка `facade.getSettings()`.
 *
 * Ни одно значение не бросает: плохая настройка → дефолт (ход не падает).
 */
export function resolveMemorySettings(raw: Record<string, unknown>): MemoryPluginSettings {
  const chunkChars = clampNumber(raw.chunkChars, MIN_CHUNK_CHARS, MAX_CHUNK_CHARS, DEFAULT_CHUNK_CHARS);
  return {
    factsLimit: clampNumber(raw.factsLimit, MIN_FACTS_LIMIT, MAX_FACTS_LIMIT, DEFAULT_FACTS_LIMIT),
    recallLimit: clampNumber(raw.recallLimit, MIN_RECALL_LIMIT, MAX_RECALL_LIMIT, DEFAULT_RECALL_LIMIT),
    minScore: clampNumber(raw.minScore, 0, 1, DEFAULT_MIN_SCORE),
    topK: clampNumber(raw.topK, MIN_TOP_K, MAX_TOP_K, DEFAULT_TOP_K),
    maxChunks: clampNumber(raw.maxChunks, MIN_MAX_CHUNKS, MAX_MAX_CHUNKS, DEFAULT_MAX_CHUNKS),
    chunkChars,
    // Перекрытие меньше чанка и не больше его — иначе нарезка бессмысленна.
    chunkOverlap: clampNumber(
      raw.chunkOverlap,
      MIN_CHUNK_OVERLAP,
      Math.min(MAX_CHUNK_OVERLAP, chunkChars - 1),
      Math.min(DEFAULT_CHUNK_OVERLAP, chunkChars - 1),
    ),
    maxFileBytes: clampNumber(
      raw.maxFileBytes,
      MIN_MAX_FILE_BYTES,
      MAX_MAX_FILE_BYTES,
      DEFAULT_MAX_FILE_BYTES,
    ),
    exclude: stringList(raw.exclude),
    embeddingModel: typeof raw.embeddingModel === 'string' ? raw.embeddingModel.trim() : '',
    dimensionProbeTtlMs: clampNumber(
      raw.dimensionProbeTtlMs,
      0,
      600_000,
      DEFAULT_DIMENSION_PROBE_TTL_MS,
    ),
  };
}
