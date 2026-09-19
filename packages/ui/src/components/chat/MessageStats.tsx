import { Fragment } from 'react'
import type { MessageData, MessageStatus } from '@/stores/chatStore'
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

const STATUS_VALUES: readonly string[] = ['completed', 'cancelled', 'stopped', 'error', 'limit']

/**
 * AD-070 §2.6: статус ответа из metadata.status. Для старых сообщений (до
 * появления поля) — fallback по metadata.i18n.key. Неизвестно → undefined
 * (трактуется как обычный ответ без префикса).
 */
function readStatus(metadata: Record<string, unknown> | null | undefined): MessageStatus | undefined {
  const raw = metadata?.status
  if (typeof raw === 'string' && STATUS_VALUES.includes(raw)) return raw as MessageStatus
  const key = (metadata?.i18n as { key?: string } | undefined)?.key
  switch (key) {
    case 'session.stopped':
    case 'session.denied_blocked':
      return 'stopped'
    case 'session.max_iterations':
      return 'limit'
    case 'session.empty_response':
    case 'router.timeout':
    case 'router.network_error':
      return 'error'
    default:
      return undefined
  }
}

/**
 * true — есть хотя бы один сегмент статистики, который отрендерит MessageStats.
 * Используется для гейтинга кнопки статистики в MessageActions.
 */
export function hasMessageStats(message: Pick<MessageData, 'usage' | 'metadata'>): boolean {
  if (message.usage) return true
  if (readNumber(message.metadata, 'duration_ms') !== undefined) return true
  if (readNumber(message.metadata, 'cost_usd') !== undefined) return true
  // Содержательный статус (остановлено/ошибка/лимит) — сам по себе сегмент.
  const status = readStatus(message.metadata)
  if (status && status !== 'completed') return true
  return false
}

interface MessageStatsProps {
  message: MessageData
  className?: string
}

/**
 * Компактная статистика ответа ассистента (AD-070 §2.6):
 * `[Остановлено ·] 11m 34s · 1.7M вх · 33.3k исх · ~$0.03 · 93% кэш · 12.3 tok/s`
 * — одной строкой без переноса.
 *
 * Префикс-сегмент отражает состояние ответа: cancelled/stopped → «Остановлено»,
 * error → «Ошибка», limit → «Лимит итераций»; completed — без префикса.
 * Сегменты показываются только при наличии данных; если данных нет — null.
 * Кэш: `cache_read_tokens / input_tokens` (0 при input = 0).
 * Скорость: `output_tokens / (duration_ms / 1000)`.
 */
export function MessageStats({ message, className }: MessageStatsProps) {
  const { t } = useI18n()

  const usage = message.usage
  const durationMs = readNumber(message.metadata, 'duration_ms')
  const costUsd = readNumber(message.metadata, 'cost_usd')
  const status = readStatus(message.metadata)

  const segments: string[] = []

  // Префикс-состояние только для не-обычных исходов.
  if (status === 'cancelled' || status === 'stopped') {
    segments.push(t('chat.messageStats.stopped'))
  } else if (status === 'error') {
    segments.push(t('chat.messageStats.error'))
  } else if (status === 'limit') {
    segments.push(t('chat.messageStats.limit'))
  }

  if (durationMs !== undefined) {
    segments.push(formatDuration(durationMs))
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
        'text-[0.6875rem] text-muted-foreground tabular-nums',
        'flex flex-nowrap items-center gap-x-1.5 whitespace-nowrap',
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
