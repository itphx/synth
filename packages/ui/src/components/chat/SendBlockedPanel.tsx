// Плашка над композером: отправка заблокирована отключённым провайдером/моделью.
//
// Ошибки приходят от `POST /sessions/:id/prompt` (`400 PROVIDER_DISABLED` /
// `MODEL_DISABLED` с `details {provider, model?}`). Текст — по коду, чтобы
// пользователь видел, что именно выбрать заново; общий тост ошибки для этих
// кодов не дублируется.

import { useI18n } from '@/lib/i18n'
import { ComposerBanner } from './ComposerBanner'

/** Коды отказа отправки, для которых показывается понятная плашка. */
export type SendBlockedCode = 'PROVIDER_DISABLED' | 'MODEL_DISABLED'

export interface SendBlockedState {
  code: SendBlockedCode
  provider?: string
  model?: string
}

/** Код ошибки отправки → состояние плашки (прочие коды — `null`). */
export function sendBlockedFromError(error: unknown): SendBlockedState | null {
  if (!error || typeof error !== 'object') return null
  const code = (error as { code?: unknown }).code
  if (code !== 'PROVIDER_DISABLED' && code !== 'MODEL_DISABLED') return null
  const details = (error as { details?: unknown }).details
  const provider =
    details && typeof details === 'object' && typeof (details as { provider?: unknown }).provider === 'string'
      ? (details as { provider: string }).provider
      : undefined
  const model =
    details && typeof details === 'object' && typeof (details as { model?: unknown }).model === 'string'
      ? (details as { model: string }).model
      : undefined
  return { code, ...(provider ? { provider } : {}), ...(model ? { model } : {}) }
}

/** ADR-117/ADR-118: плашка «провайдер/модель отключены» над полем ввода. */
export function SendBlockedPanel({ state }: { state: SendBlockedState }) {
  const { t } = useI18n()
  const provider = state.provider || '—'
  const model = state.model || '—'
  const text =
    state.code === 'MODEL_DISABLED'
      ? t('chat.sendBlocked.modelDisabled', { provider, model })
      : t('chat.sendBlocked.providerDisabled', { provider })

  return (
    <ComposerBanner
      variant="error"
      icon="error-warning"
      testId="send-blocked-panel"
      title={text}
    />
  )
}
