import { cacheHitPct, formatCost, formatTokens } from './formatStats'
import type { I18nKey, I18nParams } from './i18n/store'

type Translate = (key: I18nKey, params?: I18nParams) => string

interface UsageLike {
  input_tokens: number
  output_tokens: number
  total_tokens: number
  cache_read_tokens?: number
  cache_write_tokens?: number
  reasoning_tokens?: number
}

interface UsageStatsData {
  usage?: UsageLike | null
  costUsd?: number
  /** Валюта `costUsd` (C2a); отсутствует/неизвестна → USD. */
  costCurrency?: string
  /** `~`, если usage — best-effort оценка (ADR-070 §2.6). */
  tokenPrefix?: string
}

/**
 * ADR-070 §2.6: общие сегменты usage/cost/cache — используются и финальной
 * статистикой ответа (`MessageStats`), и live-строкой стрима
 * (`StreamingPlaceholder`): `1.7M вх · 33.3k исх · ~ 0.03 $ · 93% кэш`.
 * Порядок сегментов: вход, выход, стоимость, кэш.
 */
export function buildUsageSegments(data: UsageStatsData, t: Translate): string[] {
  const segments: string[] = []
  const usage = data.usage
  const tokenPrefix = data.tokenPrefix ?? ''

  if (usage) {
    segments.push(`${tokenPrefix}${formatTokens(usage.input_tokens ?? 0)} ${t('chat.messageStats.in')}`)
    segments.push(`${tokenPrefix}${formatTokens(usage.output_tokens ?? 0)} ${t('chat.messageStats.out')}`)
  }

  if (data.costUsd !== undefined) {
    segments.push(t('chat.messageStats.cost', { cost: formatCost(data.costUsd, data.costCurrency) }))
  }

  const inputTokens = usage?.input_tokens ?? 0
  if (inputTokens > 0) {
    const pct = cacheHitPct(usage?.cache_read_tokens, inputTokens)
    segments.push(t('chat.messageStats.cache', { pct: `${pct}%` }))
  }

  return segments
}
