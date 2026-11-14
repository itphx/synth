import { useI18n } from '@/lib/i18n'
import { SettingsPanel } from '../ui/settings'
import { SnippetScopeEditor } from '../snippets/SnippetScopeEditor'

/**
 * ADR-126 §4: личные сниппеты (Настройки → «Сниппеты»).
 *
 * Проектные — в правой панели «Проект», инстансные — в админ-разделе
 * «Сниппеты» (`SnippetsAdminSettings`).
 */
export function SnippetsSettings() {
  const { t } = useI18n()

  return (
    <SettingsPanel title={t('snippets.title')} description={t('snippets.description')}>
      <SnippetScopeEditor scope="user" canEdit />
    </SettingsPanel>
  )
}
