import { useI18n } from '@/lib/i18n'
import { SettingsPanel } from '../ui/settings'
import { ProxyStatusSection } from './ProxyStatusSection'
import { TrustedCaSection } from './TrustedCaSection'

/**
 * Админ-раздел «Сеть»: instance-wide сетевой доступ.
 *
 * Секции: «Прокси» (egress, ADR-099 D1/D2) → «Доверенные CA (TLS)»
 * (trust-бандл, default-клиент/mTLS и per-host сертификаты). Обе настройки
 * применяются при старте процесса (`restartRequired`).
 */
export function NetworkSettings() {
  const { t } = useI18n()

  return (
    <SettingsPanel title={t('network.title')} description={t('network.description')}>
      <ProxyStatusSection />
      <TrustedCaSection />
    </SettingsPanel>
  )
}
