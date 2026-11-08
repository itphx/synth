import { useHybridStore, selectIsOffline } from '@/stores/hybridStore'
import { useSessionsStore } from '@/stores/sessionsStore'
import { useProjectsStore } from '@/stores/projectsStore'
import { useTransportStore } from '@/stores/transportStore'
import { useI18n } from '@/lib/i18n'
import { Icon } from '@/components/icon/Icon'

/**
 * Неблокирующий баннер offline-деградации (гибридный режим).
 * Показывается, когда гибрид включён, но backend недоступен
 * (`enabled && !connected`) либо списки ответили offline-деградацией
 * (`remote_offline` → `hybridStore.remoteDegraded`): удалённые проекты/сессии
 * неактивны, локальные работают.
 *
 * Если показаны ранее загруженные данные (`stale` в сторах сессий/проектов),
 * добавляется пояснение «Показаны данные до потери связи» — иначе пустой/
 * усечённый список выглядит как «всё пропало».
 *
 * Только при `phase === 'online'`: если транспорт тоже не в норме, индикацию
 * берёт `ConnectionStatus` (полоса с «Повторить»/«Обновить страницу») — два
 * баннера одновременно не показываются (ADR-123).
 */
export function HybridOfflineBanner() {
  const { t } = useI18n()
  const isOffline = useHybridStore(selectIsOffline)
  const sessionsStale = useSessionsStore((s) => s.stale)
  const projectsStale = useProjectsStore((s) => s.stale)
  const phase = useTransportStore((s) => s.phase)

  if (!isOffline || phase !== 'online') return null

  const stale = sessionsStale || projectsStale

  return (
    <div
      role="status"
      className="flex items-center gap-2 border-b border-status-warning/20 bg-status-warning/10 px-3 py-1 text-xs text-status-warning"
    >
      <Icon name="error-warning" className="size-3.5 shrink-0" />
      <span className="truncate">{t('hybrid.offlineBanner')}</span>
      {stale && (
        <span className="shrink-0 opacity-80" data-testid="hybrid-stale-list">
          {t('hybrid.staleList')}
        </span>
      )}
    </div>
  )
}
