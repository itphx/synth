/**
 * Справочник известных моделей → размер контекстного окна в токенах.
 * Используется при fetch для автоматического заполнения contextWindow.
 * Источники: официальная документация провайдеров, OpenRouter.
 */

/**
 * ADR-115: модальность входа модели — какие типы вложений она принимает.
 *
 * `text` — обычный текстовый промпт (есть у любой модели); остальные —
 * vision/pdf/audio/video. Источник истины — каталог провайдера, сохраняемый
 * в `ModelConfig.modalities` при синхронизации моделей (ручной override —
 * `POST /api/v2/models`); захардкоженного справочника модальностей нет.
 * Не задано — модальности неизвестны, и вложения **не фильтруются** (ADR-115 §4).
 */
export type AttachmentModality = 'text' | 'image' | 'pdf' | 'audio' | 'video';

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
