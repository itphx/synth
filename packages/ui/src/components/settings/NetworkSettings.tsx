import { useI18n } from '@/lib/i18n'
import { SettingsPanel } from '../ui/settings'
import { ProxyStatusSection } from './ProxyStatusSection'

/**
 * Админ-раздел «Сеть»: instance-wide сетевой доступ.
 *
 * Сейчас — только egress-прокси (`ProxyStatusSection`). Следующим этапом
 * (после готовности ядра) здесь появится отдельная `SettingsSection`
 * «Доверенные CA (TLS)» — без пользовательских заглушек: раздел показывает
 * лишь реально доступные настройки.
 */
export function NetworkSettings() {
  const { t } = useI18n()

  return (
    <SettingsPanel title={t('network.title')} description={t('network.description')}>
      <ProxyStatusSection />
      {/* Следующий этап: <TrustedCaSection /> — SettingsSection «Доверенные CA (TLS)». */}
    </SettingsPanel>
  )
}
