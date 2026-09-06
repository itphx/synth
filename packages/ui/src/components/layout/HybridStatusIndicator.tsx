import { useEffect } from 'react'
import { useHybridStore, selectIsOffline } from '@/stores/hybridStore'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'

/**
 * Индикатор гибридного режима (подключение к удалённому backend).
 * Виден только когда гибрид включён (hybridStore.enabled): точка
 * зелёная/красная по connected, тултип — статус + backendUrl, клик — перезагрузка.
 * При offline (enabled && !connected) — красная точка + тултип «Сервер недоступен».
 * Поллинг стартует при монтировании и останавливается при размонтировании.
 */
export function HybridStatusIndicator() {
  const { t } = useI18n()
  const enabled = useHybridStore((s) => s.enabled)
  const connected = useHybridStore((s) => s.connected)
  const backendUrl = useHybridStore((s) => s.backendUrl)
  const isOffline = useHybridStore(selectIsOffline)
  const loadStatus = useHybridStore((s) => s.loadStatus)
  const startPolling = useHybridStore((s) => s.startPolling)
  const stopPolling = useHybridStore((s) => s.stopPolling)

  useEffect(() => {
    startPolling()
    return () => stopPolling()
  }, [startPolling, stopPolling])

  if (!enabled) return null

  const tooltip = isOffline
    ? `${t('hybrid.offline')}${backendUrl ? ` — ${backendUrl}` : ''}`
    : `${t('hybrid.connected')}${backendUrl ? ` — ${backendUrl}` : ''}`
  const dotColor = connected ? 'bg-green-400' : 'bg-red-400'
  const labelColor = connected ? 'text-green-400' : 'text-red-400'

  return (
    <button
      onClick={() => { void loadStatus() }}
      className="flex items-center gap-1.5 text-xs font-medium rounded px-2 py-1 cursor-pointer hover:bg-interactive-hover transition-colors"
      title={tooltip}
      aria-label={t('hybrid.statusTitle')}
    >
      <span className={cn('size-2 rounded-full shrink-0', dotColor)} />
      <span className={cn('device-hide-label', labelColor)}>{t('hybrid.enabled')}</span>
    </button>
  )
}
