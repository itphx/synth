import { useI18n } from '@/lib/i18n'
import { SettingsPanel } from '../ui/settings'
import { SnippetScopeEditor } from '../snippets/SnippetScopeEditor'

/**
 * ADR-141 §4: инстансные сниппеты — админ-раздел «Сниппеты» (ADMIN).
 */
export function SnippetsAdminSettings() {
  const { t } = useI18n()

  return (
    <SettingsPanel title={t('snippets.adminTitle')} description={t('snippets.adminDescription')}>
      <SnippetScopeEditor scope="instance" canEdit />
    </SettingsPanel>
  )
}
