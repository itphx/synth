import { useEffect, useState } from 'react'
import type { EgressPolicy, WebhooksEgressPolicy } from '@itphx/synth-shared/types'

import { synthApi, type EgressCheckResult } from '@/lib/api/synthApi'
import { useI18n } from '@/lib/i18n'
import { useNotification } from '@/hooks/useNotification'
import { cn } from '@/lib/utils'
import { Icon } from '../icon/Icon'
import { Button } from '../ui/button'
import {
  ListField,
  SelectField,
  SettingsActions,
  SettingsSection,
  TextField,
  useSettingsDraft,
} from '../ui/settings'
import { SelectContent, SelectItem } from '../ui/select'

/** Режим черновика: `off` доступен только для `webhooks`. */
type DraftPolicy = WebhooksEgressPolicy

const normalize = (policy: EgressPolicy | WebhooksEgressPolicy): DraftPolicy => ({
  mode: policy.mode,
  list: [...(policy.list ?? [])],
  exceptions: [...(policy.exceptions ?? [])],
})

export interface EgressPolicySectionProps {
  /** Скоуп политики: встроенные инструменты или webhooks. */
  scope: 'tools' | 'webhooks'
  /** Разрешить режим `off` (только webhooks — dev, без проверок). */
  allowOff?: boolean
  /** i18n-ключ заголовка секции. */
  titleKey: string
  /** i18n-ключ описания секции. */
  descriptionKey: string
  /** Префикс `data-testid` для тестов. */
  testIdPrefix: string
}

/**
 * Адресная egress-политика (`egress.tools` / `egress.webhooks`, ADR-071 §2.3.1 /
 * ADR-072): режим `deny`/`allow` (+`off` только webhooks), основной список
 * host/CIDR и allow-исключения, проверяемые первыми. Плюс offline-проверка URL
 * (`POST /settings/egress/check`) без выполнения запроса.
 *
 * Переиспользуется в админ-категории «Встроенные инструменты» и в разделе
 * «Webhooks». API — только через `synthApi`.
 */
export function EgressPolicySection({
  scope,
  allowOff = false,
  titleKey,
  descriptionKey,
  testIdPrefix,
}: EgressPolicySectionProps) {
  const { t } = useI18n()
  const { notify } = useNotification()

  const [policy, setPolicy] = useState<DraftPolicy | null>(null)
  const [defaults, setDefaults] = useState<DraftPolicy | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  // Offline-проверка URL (запрос не выполняется).
  const [checkUrl, setCheckUrl] = useState('')
  const [checking, setChecking] = useState(false)
  const [checkResult, setCheckResult] = useState<EgressCheckResult | null>(null)
  const [checkError, setCheckError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setLoadError(null)
    setPolicy(null)
    setDefaults(null)
    synthApi
      .getEgressPolicy(scope)
      .then((data) => {
        if (cancelled) return
        const next = normalize(data.policy)
        setPolicy(next)
        setDefaults(normalize(data.defaults))
      })
      .catch((e) => {
        if (!cancelled) {
          setLoadError(t('egress.loadError', { error: e instanceof Error ? e.message : 'HTTP' }))
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [scope, t])

  const draft = useSettingsDraft<DraftPolicy>({ value: policy, defaultValue: defaults })
  const current = draft.draft

  const handleSave = async () => {
    if (!current) return
    setSaving(true)
    try {
      const saved = normalize(await synthApi.saveEgressPolicy(scope, current))
      setPolicy(saved)
      draft.setDraft(saved)
      notify({ text: t('egress.saved'), type: 'success', category: 'system' })
    } catch (err) {
      notify({
        text: t('egress.saveError', { error: err instanceof Error ? err.message : 'HTTP' }),
        type: 'error',
        category: 'error',
      })
    } finally {
      setSaving(false)
    }
  }

  const handleReset = async () => {
    setSaving(true)
    try {
      const restored = normalize(await synthApi.resetEgressPolicy(scope))
      setPolicy(restored)
      draft.setDraft(restored)
      notify({ text: t('egress.saved'), type: 'success', category: 'system' })
    } catch (err) {
      notify({
        text: t('egress.saveError', { error: err instanceof Error ? err.message : 'HTTP' }),
        type: 'error',
        category: 'error',
      })
    } finally {
      setSaving(false)
    }
  }

  const handleCheck = async () => {
    const url = checkUrl.trim()
    if (!url) return
    setChecking(true)
    setCheckResult(null)
    setCheckError(null)
    try {
      setCheckResult(await synthApi.checkEgress(scope, url))
    } catch (err) {
      setCheckError(t('egress.check.error', { error: err instanceof Error ? err.message : 'HTTP' }))
    } finally {
      setChecking(false)
    }
  }

  return (
    <SettingsSection title={t(titleKey)} description={t(descriptionKey)}>
      <div className="space-y-3 min-w-0" data-testid={`${testIdPrefix}-section`}>
        {loading && !current && (
          <div className="text-center text-muted-foreground py-4 text-sm">{t('common.loading')}</div>
        )}

        {loadError && (
          <div role="alert" className="p-2 rounded-lg bg-destructive/10 text-destructive text-sm">
            {loadError}
          </div>
        )}

        {current && (
          <>
            <SelectField
              label={t('egress.mode')}
              description={t('egress.modeHelp')}
              value={current.mode}
              onValueChange={(mode) =>
                draft.setDraft((prev) => (prev ? { ...prev, mode: mode as DraftPolicy['mode'] } : prev))
              }
              ariaLabel={t('egress.mode')}
              triggerTestId={`${testIdPrefix}-mode`}
            >
              <SelectContent>
                <SelectItem value="deny">{t('egress.mode.deny')}</SelectItem>
                <SelectItem value="allow">{t('egress.mode.allow')}</SelectItem>
                {allowOff && <SelectItem value="off">{t('egress.mode.off')}</SelectItem>}
              </SelectContent>
            </SelectField>

            {allowOff && current.mode === 'off' && (
              <div
                role="alert"
                data-testid={`${testIdPrefix}-off-warning`}
                className="flex items-start gap-2 rounded-lg bg-destructive/10 p-2 text-xs text-destructive"
              >
                <Icon name="error-warning" className="mt-0.5 size-3.5 shrink-0" />
                <span className="min-w-0 break-words">{t('egress.offWarning')}</span>
              </div>
            )}

            <ListField
              label={t('egress.list')}
              description={t('egress.listHelp')}
              values={current.list}
              onChange={(list) => draft.setDraft((prev) => (prev ? { ...prev, list } : prev))}
              placeholder="10.0.0.0/8"
              variant="chips"
            />

            <ListField
              label={t('egress.exceptions')}
              description={t('egress.exceptionsHelp')}
              values={current.exceptions}
              onChange={(exceptions) =>
                draft.setDraft((prev) => (prev ? { ...prev, exceptions } : prev))
              }
              placeholder="api.example.com"
              variant="chips"
            />

            <div className="space-y-2 min-w-0 border-t border-border/60 pt-3">
              <div className="text-sm font-medium text-foreground">{t('egress.check.title')}</div>
              <TextField
                label={t('egress.check.url')}
                description={t('egress.check.description')}
                value={checkUrl}
                onChange={(e) => {
                  setCheckUrl(e.target.value)
                  if (checkError) setCheckError(null)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    void handleCheck()
                  }
                }}
                placeholder="https://example.com/hook"
                mono
                data-testid={`${testIdPrefix}-check-url`}
              />
              <Button
                variant="outline"
                size="sm"
                className="shrink-0"
                onClick={() => void handleCheck()}
                disabled={checking || !checkUrl.trim()}
                data-testid={`${testIdPrefix}-check-button`}
              >
                <Icon name="search" className="size-3.5" />
                {checking ? t('egress.check.checking') : t('egress.check.button')}
              </Button>

              {checkError && (
                <div
                  role="alert"
                  data-testid={`${testIdPrefix}-check-error`}
                  className="rounded-lg bg-destructive/10 p-2 text-xs text-destructive"
                >
                  {checkError}
                </div>
              )}

              {checkResult && (
                <div
                  role="status"
                  data-testid={`${testIdPrefix}-check-result`}
                  className={cn(
                    'space-y-1 rounded-lg p-2 text-xs',
                    checkResult.allowed
                      ? 'bg-status-success/10 text-status-success'
                      : 'bg-destructive/10 text-destructive',
                  )}
                >
                  <div className="font-medium">
                    {checkResult.allowed
                      ? t('egress.check.allowed')
                      : t('egress.check.blocked', { reason: checkResult.reason ?? '—' })}
                  </div>
                  {checkResult.matchedRule && (
                    <div className="min-w-0 break-words">
                      {t('egress.check.matchedRule', { rule: checkResult.matchedRule })}
                    </div>
                  )}
                  {checkResult.addresses && checkResult.addresses.length > 0 && (
                    <div className="min-w-0 break-words font-mono">
                      {t('egress.check.addresses', { addresses: checkResult.addresses.join(', ') })}
                    </div>
                  )}
                </div>
              )}
            </div>

            <SettingsActions
              onSave={() => void handleSave()}
              onCancel={() => draft.revert()}
              onReset={() => void handleReset()}
              saveDisabled={loading || !draft.dirty}
              cancelDisabled={!draft.dirty}
              isDefault={draft.isDefault}
              saving={saving}
              saveTestId={`${testIdPrefix}-save`}
              cancelTestId={`${testIdPrefix}-cancel`}
              resetTestId={`${testIdPrefix}-reset`}
            />
          </>
        )}
      </div>
    </SettingsSection>
  )
}
