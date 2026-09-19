import { Fragment } from 'react'
import type { MessageData } from '@/stores/chatStore'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { formatCost, formatDuration, formatTokens, formatTps } from '@/lib/formatStats'

/** metadata.duration_ms / metadata.cost_usd приходят как unknown — читаем только number. */
function readNumber(
  metadata: Record<string, unknown> | null | undefined,
  key: string,
): number | undefined {
  const value = metadata?.[key]
  return typeof value === 'number' ? value : undefined
}

/**
 * true — есть хотя бы один сегмент статистики, который отрендерит MessageStats.
 * Используется для гейтинга кнопки-переключателя в MessageActions.
 */
export function hasMessageStats(message: Pick<MessageData, 'usage' | 'metadata'>): boolean {
  if (message.usage) return true
  if (readNumber(message.metadata, 'duration_ms') !== undefined) return true
  if (readNumber(message.metadata, 'cost_usd') !== undefined) return true
  return false
}

interface MessageStatsProps {
  message: MessageData
  className?: string
}

/**
 * Компактная строка статистики ответа ассистента (AD-070 §2.6):
 * `Done in 11m 34s · 1.7M in · 33.3k out · ~$0.03 · 93% из кэша · 12.3 tok/s`.
 *
 * Сегменты показываются только при наличии данных; если данных нет — null.
 * Кэш: `cache_read_tokens / input_tokens` (0 при input = 0).
 * Скорость: `output_tokens / (duration_ms / 1000)`.
 */
export function MessageStats({ message, className }: MessageStatsProps) {
  const { t } = useI18n()

  const usage = message.usage
  const durationMs = readNumber(message.metadata, 'duration_ms')
  const costUsd = readNumber(message.metadata, 'cost_usd')

  const segments: string[] = []

  if (durationMs !== undefined) {
    segments.push(t('chat.messageStats.doneIn', { duration: formatDuration(durationMs) }))
  }

  if (usage) {
    segments.push(`${formatTokens(usage.input_tokens ?? 0)} ${t('chat.messageStats.in')}`)
    segments.push(`${formatTokens(usage.output_tokens ?? 0)} ${t('chat.messageStats.out')}`)
  }

  if (costUsd !== undefined) {
    segments.push(t('chat.messageStats.cost', { cost: formatCost(costUsd) }))
  }

  const inputTokens = usage?.input_tokens ?? 0
  if (inputTokens > 0) {
    const pct = Math.round(((usage?.cache_read_tokens ?? 0) / inputTokens) * 100)
    segments.push(t('chat.messageStats.cache', { pct: `${pct}%` }))
  }

  if (durationMs !== undefined && durationMs > 0 && usage) {
    const tps = (usage.output_tokens ?? 0) / (durationMs / 1000)
    segments.push(t('chat.messageStats.speed', { speed: formatTps(tps) }))
  }

  if (segments.length === 0) return null

  return (
    <div
      data-testid="message-stats"
      className={cn(
        'flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[0.6875rem] text-muted-foreground tabular-nums',
        className,
      )}
    >
      {segments.map((segment, i) => (
        <Fragment key={i}>
          {i > 0 && <span aria-hidden="true">·</span>}
          <span>{segment}</span>
        </Fragment>
      ))}
    </div>
  )
}
