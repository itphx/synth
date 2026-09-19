import type { SessionSubagentStats } from '@itphx/synth-shared'

/** Значение из metadata приходит как unknown — читаем только конечные number. */
function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/**
 * AD-070 §2.6: per-message статистика сабагентов из `metadata.subagents`
 * финального assistant-сообщения (агрегат task-результатов этого хода).
 * Возвращает `undefined`, если сабагентов нет или структура невалидна.
 *
 * Не путать с `SessionStats.subagents` — сессионной сводкой по всем детям.
 */
export function readMessageSubagents(
  metadata: Record<string, unknown> | null | undefined,
): SessionSubagentStats | undefined {
  const raw = metadata?.subagents
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const sessions = num(r.sessions)
  if (sessions <= 0) return undefined
  return {
    sessions,
    input_tokens: num(r.input_tokens),
    output_tokens: num(r.output_tokens),
    cache_read_tokens: num(r.cache_read_tokens),
    cache_write_tokens: num(r.cache_write_tokens),
    reasoning_tokens: num(r.reasoning_tokens),
    cost_usd: num(r.cost_usd),
  }
}
