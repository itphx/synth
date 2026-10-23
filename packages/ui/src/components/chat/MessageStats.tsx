import { Fragment } from 'react'
import type { MessageData, MessageStatus } from '@/stores/chatStore'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { formatCostMap, formatDuration, formatTokens, formatTps, tokensPerSecond } from '@/lib/formatStats'
import { buildUsageSegments } from '@/lib/statsSegments'
import { readMessageSubagents } from '@/lib/subagentStats'

/** metadata.duration_ms / metadata.cost_usd приходят как unknown — читаем только number. */
function readNumber(
  metadata: Record<string, unknown> | null | undefined,
  key: string,
): number | undefined {
  const value = metadata?.[key]
  return typeof value === 'number' ? value : undefined
}

const STATUS_VALUES: readonly string[] = ['completed', 'cancelled', 'stopped', 'error', 'limit', 'interrupted']

/**
 * ADR-070 §2.6: статус ответа из metadata.status. Для старых сообщений (до
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
  // ADR-070 §2.6: сабагенты без usage/duration/cost — тоже валидный сегмент.
  if (readMessageSubagents(message.metadata)) return true
  return false
}

interface MessageStatsProps {
  message: MessageData
  className?: string
}

/**
 * Компактная статистика ответа ассистента (ADR-070 §2.6):
 * `[Остановлено ·] 11m 34s · 1.7M вх · 33.3k исх · ~ 0.03 $ · 93% кэш · 12.3 tok/s`
 * — одной строкой без переноса.
 *
 * При наличии `metadata.subagents` добавляется вторая строка:
 * `Сабагенты: 2 · 12.3k вх · 1.1k исх [· ~ 0.0003 $]`.
 *
 * Префикс-сегмент отражает состояние ответа: cancelled/stopped → «Остановлено»,
 * error → «Ошибка», limit → «Лимит итераций», interrupted → «Прервано»
 * (ADR-104 `interrupt`); completed — без префикса.
 * Сегменты показываются только при наличии данных; если данных нет — null.
 * Кэш: `cache_read_tokens / input_tokens` (0 при input = 0).
 * Скорость: `output_tokens / (duration_ms / 1000)`.
 */
export function MessageStats({ message, className }: MessageStatsProps) {
  const { t } = useI18n()

  const usage = message.usage
  const durationMs = readNumber(message.metadata, 'duration_ms')
  const costUsd = readNumber(message.metadata, 'cost_usd')
  // C2b: валюта `cost_usd` хода (ядро пишет `metadata.cost_currency`; C2a).
  const costCurrency = typeof message.metadata?.cost_currency === 'string'
    ? message.metadata.cost_currency
    : undefined
  const status = readStatus(message.metadata)
  // Bug 4 (ADR-070 §2.6): usage мог быть оценён (провайдер не успел отдать
  // финальный чанк при отмене/сбое) — помечаем токены `~`, чтобы не выдавать
  // оценку за точные данные.
  const usageEstimated = message.metadata?.usage_estimated === true
  const tokenPrefix = usageEstimated ? '~' : ''

  const segments: string[] = []

  // Префикс-состояние только для не-обычных исходов.
  if (status === 'cancelled' || status === 'stopped') {
    segments.push(t('chat.messageStats.stopped'))
  } else if (status === 'error') {
    segments.push(t('chat.messageStats.error'))
  } else if (status === 'limit') {
    segments.push(t('chat.messageStats.limit'))
  } else if (status === 'interrupted') {
    // ADR-104 (этап 2): генерация прервана пользователем, ход продолжился.
    segments.push(t('chat.messageStats.interrupted'))
  }

  if (durationMs !== undefined) {
    segments.push(formatDuration(durationMs))
  }

  // ADR-070 §2.6: общий с live-строкой стрима билдер сегментов usage/cost/cache.
  segments.push(...buildUsageSegments({ usage, costUsd, costCurrency, tokenPrefix }, t))

  if (usage) {
    const tps = tokensPerSecond(usage.output_tokens, durationMs)
    if (tps !== undefined) segments.push(t('chat.messageStats.speed', { speed: formatTps(tps) }))
  }

  // ADR-070 §2.6: отдельная (вторая) строка статистики сабагентов этого хода.
  const subagents = readMessageSubagents(message.metadata)
  const subagentSegments: string[] = []
  if (subagents) {
    subagentSegments.push(`${t('rightPanel.stats.subagentsTitle')}: ${subagents.sessions}`)
    subagentSegments.push(`${formatTokens(subagents.input_tokens)} ${t('chat.messageStats.in')}`)
    subagentSegments.push(`${formatTokens(subagents.output_tokens)} ${t('chat.messageStats.out')}`)
    if (subagents.cost_usd > 0) {
      subagentSegments.push(
        t('chat.messageStats.cost', {
          cost: formatCostMap(subagents.cost_by_currency, subagents.cost_usd),
        }),
      )
    }
  }

  if (segments.length === 0 && subagentSegments.length === 0) return null

  return (
    <div
      data-testid="message-stats"
      className={cn(
        'text-[0.6875rem] text-foreground tabular-nums',
        subagents
          ? 'flex flex-col gap-y-0.5'
          : 'flex flex-nowrap items-center gap-x-1.5 whitespace-nowrap',
        className,
      )}
    >
      {segments.length > 0 && <StatsRow segments={segments} />}
      {subagentSegments.length > 0 && <StatsRow segments={subagentSegments} />}
    </div>
  )
}

/** Одна строка сегментов, разделённых `·`, без переноса. */
function StatsRow({ segments }: { segments: string[] }) {
  return (
    <div className="flex flex-nowrap items-center gap-x-1.5 whitespace-nowrap">
      {segments.map((segment, i) => (
        <Fragment key={i}>
          {i > 0 && <span aria-hidden="true">·</span>}
          <span>{segment}</span>
        </Fragment>
      ))}
    </div>
  )
}
