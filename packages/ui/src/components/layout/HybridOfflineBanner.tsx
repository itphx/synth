import { useHybridStore, selectIsOffline } from '@/stores/hybridStore'
import { useI18n } from '@/lib/i18n'
import { Icon } from '@/components/icon/Icon'

/**
 * Неблокирующий баннер offline-деградации (гибридный режим).
 * Показывается только когда гибрид включён, но backend недоступен
 * (enabled && !connected): удалённые проекты/сессии неактивны, локальные работают.
 */
export function HybridOfflineBanner() {
  const { t } = useI18n()
  const isOffline = useHybridStore(selectIsOffline)

  if (!isOffline) return null

  return (
    <div
      role="status"
      className="flex items-center gap-2 border-b border-status-warning/20 bg-status-warning/10 px-3 py-1 text-xs text-status-warning"
    >
      <Icon name="error-warning" className="size-3.5 shrink-0" />
      <span className="truncate">{t('hybrid.offlineBanner')}</span>
    </div>
  )
}
