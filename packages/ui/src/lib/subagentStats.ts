import type { SessionSubagentStats } from '@itphx/synth-shared'

/**
 * C2a: per-message статистика сабагентов + валюта стоимости.
 * `cost_currency` приходит из metadata (ядро); если поле не задано, но в
 * `cost_by_currency` ровно одна валюта — берём её (однозначный случай).
 */
type MessageSubagentStats = SessionSubagentStats & { costCurrency?: string }

/** Значение из metadata приходит как unknown — читаем только конечные number. */
function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** Значение из metadata приходит как unknown — читаем только непустые string. */
function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** C2b: карта `cost_by_currency` из metadata — только положительные числа. */
function numMap(value: unknown): Record<string, number> | undefined {
  if (!value || typeof value !== 'object') return undefined
  const out: Record<string, number> = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) out[key] = raw
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * ADR-070 §2.6: per-message статистика сабагентов из `metadata.subagents`
 * финального assistant-сообщения (агрегат task-результатов этого хода).
 * Возвращает `undefined`, если сабагентов нет или структура невалидна.
 *
 * Не путать с `SessionStats.subagents` — сессионной сводкой по всем детям.
 */
export function readMessageSubagents(
  metadata: Record<string, unknown> | null | undefined,
): MessageSubagentStats | undefined {
  const raw = metadata?.subagents
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const sessions = num(r.sessions)
  if (sessions <= 0) return undefined

  let costCurrency = str(r.cost_currency)
  if (!costCurrency) {
    const byCurrency = r.cost_by_currency
    const keys = byCurrency && typeof byCurrency === 'object'
      ? Object.keys(byCurrency as Record<string, unknown>)
      : []
    if (keys.length === 1) costCurrency = keys[0]
  }

  const costByCurrency = numMap(r.cost_by_currency)

  return {
    sessions,
    input_tokens: num(r.input_tokens),
    output_tokens: num(r.output_tokens),
    cache_read_tokens: num(r.cache_read_tokens),
    cache_write_tokens: num(r.cache_write_tokens),
    reasoning_tokens: num(r.reasoning_tokens),
    cost_usd: num(r.cost_usd),
    ...(costByCurrency ? { cost_by_currency: costByCurrency } : {}),
    ...(costCurrency ? { costCurrency } : {}),
  }
}
