import { Icon } from '../icon/Icon'
import { useI18n } from '@/lib/i18n'

interface QueueBannerProps {
  pendingCount: number
  onResume: () => void
  onClear: () => void
  onReturn: () => void
}

export function QueueBanner({ pendingCount, onResume, onClear, onReturn }: QueueBannerProps) {
  const { t } = useI18n()

  if (pendingCount === 0) return null

  return (
    <div className="flex items-center gap-2 px-4 py-2 bg-yellow-500/10 border-b border-yellow-500/20">
      <Icon name="error-warning" className="size-4 text-yellow-500 shrink-0" />
      <span className="text-xs text-yellow-600 dark:text-yellow-400 flex-1">
        {t('chat.queue.stalled', { count: String(pendingCount) })}
      </span>
      <div className="flex items-center gap-1">
        <button
          onClick={onResume}
          className="rounded px-2 py-0.5 text-[11px] font-medium bg-yellow-500/20 text-yellow-700 dark:text-yellow-300 hover:bg-yellow-500/30 transition-colors"
        >
          {t('chat.queue.resume')}
        </button>
        <button
          onClick={onReturn}
          className="rounded px-2 py-0.5 text-[11px] text-yellow-600 dark:text-yellow-400 hover:bg-yellow-500/10 transition-colors"
        >
          {t('chat.queue.return')}
        </button>
        <button
          onClick={onClear}
          className="rounded px-2 py-0.5 text-[11px] text-yellow-600 dark:text-yellow-400 hover:bg-yellow-500/10 transition-colors"
        >
          {t('chat.queue.clear')}
        </button>
      </div>
    </div>
  )
}
