/**
 * Нормализация ответа GET /api/v2/models.
 *
 * Бэкенд (backend и core-standalone) отдаёт модели в camelCase
 * (contextWindow, contextSource, maxOutputTokens, inputPrice, ...), а UI-тип
 * ModelInfo объявляет snake_case (context_window, ...). Единственная точка
 * получения списка моделей в UI — synthApi.getModels(), поэтому маппинг
 * выполняется здесь, идемпотентно: если источник уже отдал snake_case — поля
 * не трогаем.
 */
export const MODEL_CAMEL_TO_SNAKE: Record<string, string> = {
  contextWindow: 'context_window',
  contextSource: 'context_source',
  maxOutputTokens: 'max_tokens',
  inputPrice: 'input_price',
  outputPrice: 'output_price',
  cacheReadPrice: 'cache_read_price',
  cacheWritePrice: 'cache_write_price',
}

export function normalizeModelInfo(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...raw }
  for (const [camel, snake] of Object.entries(MODEL_CAMEL_TO_SNAKE)) {
    if (camel in out && !(snake in out)) {
      out[snake] = out[camel]
      delete out[camel]
    }
  }
  return out
}
