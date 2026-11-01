import { useI18n } from '@/lib/i18n'
import { useContextWindowPolicy } from '@/lib/api/contextWindowSettings'
import {
  CONTEXT_BLOCK_PERCENT,
  useContextWindowUsage,
} from '@/hooks/useContextWindowUsage'
import { ComposerBanner } from './ComposerBanner'

interface ContextWarningPanelProps {
  sessionId: string
}

/**
 * Жёлтый блок над композером при заполнении контекстного окна ≥ 90%.
 *
 * Числа берутся из общего хука (`useContextWindowUsage`) — ровно те же, что в
 * шапке и в «Последнем ответе» правой панели. Политика инстанса `off` выключает
 * предупреждение целиком. Полный список советов — под сворачиваемым блоком:
 * постоянный длинный текст в чате мешает.
 */
export function ContextWarningPanel({ sessionId }: ContextWarningPanelProps) {
  const { t, locale } = useI18n()
  const policy = useContextWindowPolicy()
  const { inputTokens, windowTokens, percent, isEstimated } = useContextWindowUsage(sessionId)

  if (policy === 'off' || percent < CONTEXT_BLOCK_PERCENT) return null

  const fmt = (value: number): string => value.toLocaleString(locale)

  return (
    <ComposerBanner
      variant="warning"
      icon="error-warning"
      testId="context-warning-panel"
      title={t('chat.context.blockTitle', {
        percent,
        used: fmt(inputTokens),
        max: fmt(windowTokens),
      })}
      details={{
        summary: t('chat.context.details'),
        content: (
          <ul className="list-disc space-y-0.5 pl-4">
            <li>{t('chat.context.actionSummarize')}</li>
            <li>{t('chat.context.actionAuto')}</li>
            <li>{t('chat.context.actionDisable')}</li>
          </ul>
        ),
      }}
    >
      <span className="block text-[0.6875rem] text-muted-foreground">
        {t('chat.context.blockHint')}
      </span>
      {isEstimated && (
        <span className="block text-[0.625rem] text-muted-foreground">
          {t('chat.context.estimated', { max: fmt(windowTokens) })}
        </span>
      )}
    </ComposerBanner>
  )
}
