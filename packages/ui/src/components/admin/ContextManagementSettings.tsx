import { useI18n } from '@/lib/i18n'
import { SettingsPanel } from '@/components/ui/settings'
import { ContextDefaultsSettings } from './ContextDefaultsSettings'
import { ContextWindowSettings } from './ContextWindowSettings'
import { StickyNotesLimitsSettings } from './StickyNotesLimitsSettings'

/**
 * ADR-072: админ-раздел «Управление контекстом» (группа «AI и модели»).
 *
 * Одна страница с тремя блоками:
 * 1. значения по умолчанию для новых сессий (`/settings/context-defaults`);
 * 2. политика контекстного окна (`/settings/context-window`) — существующая
 *    панель во встроенном режиме (без собственного заголовка страницы);
 * 3. лимиты заметок (`/settings/sticky-notes`) — `context.stickyNotes`.
 *
 * Все блоки живут в одном `SettingsPanel`: единственный вертикальный скролл,
 * общая шапка и режим «Расширенные» (ADR-072).
 */
export function ContextManagementSettings() {
  const { t } = useI18n()

  return (
    <SettingsPanel
      title={t('settings.contextManagement.title')}
      description={t('settings.contextManagement.description')}
    >
      <ContextDefaultsSettings />
      <ContextWindowSettings embedded />
      <StickyNotesLimitsSettings />
    </SettingsPanel>
  )
}
