/**
 * Справочник известных моделей → размер контекстного окна в токенах.
 * Используется при fetch для автоматического заполнения contextWindow.
 * Источники: официальная документация провайдеров, OpenRouter.
 */

/**
 * ADR-115: модальность входа модели — какие типы вложений она принимает.
 *
 * `text` — обычный текстовый промпт (есть у любой модели); остальные — vision/
 * pdf/audio/video. Карта `KNOWN_MODEL_MODALITIES` — **эталон** известных
 * моделей; для неизвестной модели действует консервативный фолбэк `['text']`
 * (вложение модель без поддержки не получит — ADR-115 §4).
 */
export type AttachmentModality = 'text' | 'image' | 'pdf' | 'audio' | 'video';

/** Модальности, которые принимает модель (по справочнику известных моделей). */
export const KNOWN_MODEL_MODALITIES: Record<string, AttachmentModality[]> = {
  // OpenAI — текст + изображения (+ файлы-pdf у моделей с file-input).
  'gpt-4o-audio-preview': ['text', 'audio', 'image'],
  'gpt-4o-mini-audio-preview': ['text', 'audio', 'image'],
  'gpt-4o': ['text', 'image', 'pdf'],
  'gpt-4o-mini': ['text', 'image', 'pdf'],
  'gpt-4.1': ['text', 'image', 'pdf'],
  'gpt-4.1-mini': ['text', 'image', 'pdf'],
  'gpt-4.1-nano': ['text', 'image', 'pdf'],
  'gpt-4-turbo': ['text', 'image'],
  'o4-mini': ['text', 'image'],
  'o3-mini': ['text', 'image'],
  'o3': ['text', 'image'],
  'o1': ['text', 'image'],

  // Anthropic — текст + изображения + документы (pdf).
  'claude-3-opus': ['text', 'image', 'pdf'],
  'claude-3-sonnet': ['text', 'image', 'pdf'],
  'claude-3-haiku': ['text', 'image', 'pdf'],
  'claude-3-5-sonnet': ['text', 'image', 'pdf'],
  'claude-3-5-haiku': ['text', 'image', 'pdf'],
  'claude-sonnet-4': ['text', 'image', 'pdf'],
  'claude-haiku-4': ['text', 'image', 'pdf'],
  'claude-opus-4': ['text', 'image', 'pdf'],

  // Google — текст + изображения + документы + аудио/видео.
  'gemini-2.5': ['text', 'image', 'pdf', 'audio', 'video'],
  'gemini-2.0': ['text', 'image', 'pdf', 'audio', 'video'],
  'gemini-1.5': ['text', 'image', 'pdf', 'audio', 'video'],

  // Локальные/открытые vision-модели: текст + изображения (семейство без
  // суффикса `-vl`/`-vision` остаётся текстовым — см. ниже).
  'deepseek-v4.1-flash': ['text', 'image'],
  'deepseek-v4-flash-vision': ['text', 'image'],
  'deepseek-vl': ['text', 'image'],
  'qwen2.5-vl': ['text', 'image'],
  'qwen3-vl': ['text', 'image'],
  'llama-3.2-vision': ['text', 'image'],
  'llava': ['text', 'image'],
  'minicpm-v': ['text', 'image'],
  'internvl': ['text', 'image'],
  'gemma-3': ['text', 'image'],
  'phi-4-multimodal': ['text', 'image', 'audio'],
  'mistral-small-3': ['text', 'image'],

  // Остальные известные модели — только текст.
  'deepseek': ['text'],
  'mistral': ['text'],
  'codestral': ['text'],
  'ministral': ['text'],
  'llama': ['text'],
  'qwen': ['text'],
  'qwq': ['text'],
  'command-r': ['text'],
  'command-a': ['text'],
  'pixtral': ['text', 'image'],
  'jamba': ['text'],
};

export const KNOWN_MODEL_WINDOWS: Record<string, number> = {
  // OpenAI
  'gpt-4o': 128_000,
  'gpt-4o-mini': 128_000,
  'gpt-4o-2024-08-06': 128_000,
  'gpt-4o-2024-05-13': 128_000,
  'gpt-4-turbo': 128_000,
  'gpt-4-turbo-preview': 128_000,
  'gpt-4-turbo-2024-04-09': 128_000,
  'gpt-4-0125-preview': 128_000,
  'gpt-4-1106-preview': 128_000,
  'gpt-4': 8_192,
  'gpt-4-32k': 32_768,
  'gpt-4-0613': 8_192,
  'gpt-4-32k-0613': 32_768,
  'gpt-3.5-turbo': 16_384,
  'gpt-3.5-turbo-0125': 16_384,
  'gpt-3.5-turbo-1106': 16_384,
  'gpt-3.5-turbo-16k': 16_384,
  'gpt-3.5-turbo-instruct': 4_096,
  'o1': 200_000,
  'o1-mini': 128_000,
  'o1-preview': 128_000,
  'o3-mini': 200_000,
  'o3': 200_000,
  'o4-mini': 200_000,

  // Anthropic
  'claude-3-opus-20240229': 200_000,
  'claude-3-sonnet-20240229': 200_000,
  'claude-3-haiku-20240307': 200_000,
  'claude-3-5-sonnet-20240620': 200_000,
  'claude-3-5-sonnet-20241022': 200_000,
  'claude-3-5-sonnet-latest': 200_000,
  'claude-3-5-haiku-20241022': 200_000,
  'claude-3-5-haiku-latest': 200_000,
  'claude-sonnet-4-20250514': 200_000,
  'claude-sonnet-4': 200_000,
  'claude-haiku-4-20250514': 200_000,
  'claude-haiku-4': 200_000,
  'claude-opus-4-20250514': 200_000,
  'claude-opus-4': 200_000,

  // Google
  'gemini-2.0-flash': 1_048_576,
  'gemini-2.0-flash-lite': 1_048_576,
  'gemini-2.0-pro': 2_097_152,
  'gemini-2.5-pro': 1_048_576,
  'gemini-2.5-flash': 1_048_576,
  'gemini-1.5-pro': 2_097_152,
  'gemini-1.5-flash': 1_048_576,
  'gemini-1.5-pro-002': 2_097_152,
  'gemini-1.5-flash-002': 1_048_576,
  'gemini-1.0-pro': 32_768,

  // DeepSeek
  'deepseek-chat': 128_000,
  'deepseek-v3': 128_000,
  'deepseek-r1': 128_000,
  'deepseek-coder': 128_000,

  // Mistral
  'mistral-large-latest': 128_000,
  'mistral-large-2411': 128_000,
  'mistral-large-2407': 128_000,
  'mistral-medium': 32_000,
  'mistral-small-latest': 32_000,
  'mistral-small-2501': 32_000,
  'mistral-small-2409': 32_000,
  'codestral-latest': 256_000,
  'codestral-2501': 256_000,
  'codestral-2405': 32_000,
  'ministral-3b': 128_000,
  'ministral-8b': 128_000,
  'mistral-nemo': 128_000,

  // Meta (Llama via providers)
  'llama-3.1-405b': 128_000,
  'llama-3.1-70b': 128_000,
  'llama-3.1-8b': 128_000,
  'llama-3.2-90b': 128_000,
  'llama-3.2-11b': 128_000,
  'llama-3.2-3b': 128_000,
  'llama-3.2-1b': 128_000,
  'llama-3.3-70b': 128_000,
  'llama-4-scout': 128_000,
  'llama-4-maverick': 128_000,

  // OpenRouter / другие
  'qwen2.5-72b': 128_000,
  'qwen2.5-32b': 128_000,
  'qwen2.5-14b': 128_000,
  'qwen2.5-7b': 128_000,
  'qwen2.5-coder-32b': 128_000,
  'qwq-32b': 128_000,
  'command-r-plus': 128_000,
  'command-r': 128_000,
  'command-a': 256_000,
  'pixtral-large': 128_000,
  'pixtral-12b': 128_000,
  'jamba-1.5-large': 256_000,
  'jamba-1.5-mini': 256_000,
};

/**
 * Ищет известное контекстное окно для модели по её ID или имени.
 * Отрезает префиксы провайдеров (openai/, google/, ...) перед поиском.
 * Проверяет точное совпадение, затем по префиксам (без суффиксов дат).
 */
export function lookupContextWindow(modelId: string): { window: number; source: 'reference' | 'unknown' } {
  let key = modelId.toLowerCase();

  // Отрезаем префикс провайдера (напр. "openai/gpt-4o" → "gpt-4o",
  // "openrouter/openai/gpt-4o" → "gpt-4o")
  const slashIdx = key.lastIndexOf('/');
  if (slashIdx >= 0) {
    key = key.slice(slashIdx + 1);
  }

  // Точное совпадение
  const exactMatch = KNOWN_MODEL_WINDOWS[key];
  if (exactMatch !== undefined) {
    return { window: exactMatch, source: 'reference' };
  }

  // Отсекаем суффиксы дат (:beta, :free, :2024-01-01) для поиска
  const baseId = key.split(':')[0]!;
  if (baseId !== key) {
    const baseMatch = KNOWN_MODEL_WINDOWS[baseId];
    if (baseMatch !== undefined) {
      return { window: baseMatch, source: 'reference' };
    }
  }

  // Поиск по префиксу (совпадение с началом известной модели)
  for (const [knownId, window] of Object.entries(KNOWN_MODEL_WINDOWS)) {
    if (key.startsWith(knownId.toLowerCase())) {
      return { window, source: 'reference' };
    }
  }

  return { window: 0, source: 'unknown' };
}

/** Консервативный фолбэк для неизвестной модели (ADR-115): только текст. */
const DEFAULT_MODEL_MODALITIES: AttachmentModality[] = ['text'];

/**
 * Ключи справочника модальностей, отсортированные по убыванию длины.
 *
 * Поиск по префиксу идёт по **самому длинному** совпавшему ключу: иначе исход
 * решал бы порядок вставки в объект и общий `deepseek` (только текст) съедал бы
 * `deepseek-v4.1-flash` (текст + изображения).
 */
const MODALITY_KEYS_BY_LENGTH: ReadonlyArray<readonly [string, AttachmentModality[]]> =
  Object.entries(KNOWN_MODEL_MODALITIES)
    .map(([key, modalities]) => [key.toLowerCase(), modalities] as const)
    .sort(([a], [b]) => b.length - a.length);

/**
 * ADR-115: модальности входа модели (какие вложения она принимает).
 *
 * Порядок поиска (как у `lookupContextWindow`): точное совпадение → id без
 * суффикса даты (`:2024-08-06`, `:free`, `:beta`) → совпадение по префиксу
 * (самый длинный ключ). Ключ с именем провайдера (`openai/gpt-4o`)
 * проверяется раньше «голого» id.
 *
 * Модели в справочнике нет → **консервативный фолбэк** `['text']`: вложение
 * такой модели не отправляется (ADR-115 §4), а не уходит «наугад».
 */
export function resolveModelModalities(
  providerName: string | undefined,
  modelId: string,
): AttachmentModality[] {
  const candidates: string[] = [];
  if (providerName) {
    const provider = providerName.trim().toLowerCase();
    if (provider !== '') candidates.push(`${provider}/${modelId}`);
  }
  candidates.push(modelId);

  for (const candidate of candidates) {
    const key = normalizeModelKey(candidate);
    if (key === '') continue;

    const exact = KNOWN_MODEL_MODALITIES[key];
    if (exact) return [...exact];

    const baseId = key.split(':')[0]!;
    if (baseId !== key) {
      const base = KNOWN_MODEL_MODALITIES[baseId];
      if (base) return [...base];
    }

    for (const [knownId, modalities] of MODALITY_KEYS_BY_LENGTH) {
      if (key.startsWith(knownId)) {
        return [...modalities];
      }
    }
  }

  return [...DEFAULT_MODEL_MODALITIES];
}

/**
 * Нормализация id модели для поиска в справочниках: нижний регистр, без
 * префикса провайдера (`openai/gpt-4o` → `gpt-4o`).
 */
function normalizeModelKey(modelId: string): string {
  let key = modelId.toLowerCase();
  const slashIdx = key.lastIndexOf('/');
  if (slashIdx >= 0) {
    key = key.slice(slashIdx + 1);
  }
  return key;
}
