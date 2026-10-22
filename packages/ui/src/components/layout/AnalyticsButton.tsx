import { cn } from '@/lib/utils'
import { useI18n } from '@/lib/i18n'
import { useDevice } from '@/hooks/useDevice'
import { useUIStore } from '@/stores/useUIStore'
import { Icon } from '../icon/Icon'

/**
 * ADR-102: вход в «Аналитику и отчёты» из шапки приложения.
 *
 * Кнопка живёт в шапке (Header), а не в правой панели: панель на телефоне —
 * дровер, и кнопка в её сетке вкладок была спрятана внизу. Экземпляр один:
 * `Header` смонтирован единожды (в `App.tsx` общая `centerColumn` для десктопа
 * и мобильной раскладки — рендерится только одна из них).
 *
 * Роль доступа не проверяем здесь — RBAC отдаёт сервер (403 → `analytics.forbidden`),
 * как и для пункта меню пользователя (`QuickSettingsPopup`).
 */
export function AnalyticsButton({ className }: { className?: string }) {
  const { t } = useI18n()
  const setAnalyticsDialogOpen = useUIStore((s) => s.setAnalyticsDialogOpen)
  const { deviceType } = useDevice()
  // Touch-таргет ≥ 40px (ADR-044); на десктопе — компактная иконка.
  const touch = deviceType !== 'desktop'

  return (
    <button
      type="button"
      onClick={() => setAnalyticsDialogOpen(true)}
      title={t('analytics.title')}
      aria-label={t('analytics.title')}
      data-testid="header-analytics"
      className={cn(
        'flex shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground',
        touch ? 'h-10 w-10' : 'h-8 w-8',
        className,
      )}
    >
      <Icon name="chart-line" className="h-4 w-4" />
    </button>
  )
}
