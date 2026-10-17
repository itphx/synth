import { useEffect, useState } from 'react'
import type { EgressProxyStatus, ProxyCheckResult } from '@itphx/synth-shared'

import { synthApi } from '@/lib/api/synthApi'
import { useI18n } from '@/lib/i18n'
import { useNotification } from '@/hooks/useNotification'
import { cn } from '@/lib/utils'
import { Icon } from '../icon/Icon'
import { Button } from '../ui/button'
import { SettingsRow, SettingsSection } from '../ui/settings'

const BADGE = 'rounded px-1.5 py-0.5 text-[0.625rem] font-medium'

/**
 * ADR-099 (D1) / ADR-072: read-only статус egress-прокси и проверка коннекта.
 *
 * Настройка применяется при старте процесса (`restartRequired`), поэтому здесь
 * нет Save/полей ввода. URL приходит redacted — креды UI не получает и не
 * показывает. Проверка (`POST /settings/proxy/check`) идёт к самому прокси,
 * а не к целевым адресам; auth-схема (Basic/NTLM/Negotiate) только распознаётся.
 */
export function ProxyStatusSection() {
  const { t } = useI18n()
  const { notify } = useNotification()

  const [status, setStatus] = useState<EgressProxyStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [checking, setChecking] = useState(false)
  const [result, setResult] = useState<ProxyCheckResult | null>(null)
  const [checkError, setCheckError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    synthApi
      .getProxyStatus()
      .then((data) => {
        if (!cancelled) setStatus(data)
      })
      .catch((e) => {
        if (cancelled) return
        const message = e instanceof Error ? e.message : 'HTTP'
        setLoadError(t('proxy.error', { error: message }))
        notify({
          text: t('proxy.error', { error: message }),
          type: 'error',
          category: 'error',
        })
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [t, notify])

  const handleCheck = async () => {
    setChecking(true)
    setResult(null)
    setCheckError(null)
    try {
      setResult(await synthApi.checkProxy())
    } catch (e) {
      const message = e instanceof Error ? e.message : 'HTTP'
      setCheckError(message)
      notify({
        text: t('proxy.checkError', { error: message }),
        type: 'error',
        category: 'error',
      })
    } finally {
      setChecking(false)
    }
  }

  return (
    <SettingsSection title={t('proxy.title')} description={t('proxy.description')}>
      <div className="space-y-3 min-w-0" data-testid="proxy-status-section">
        {loading && !status && (
          <div className="text-center text-muted-foreground py-4 text-sm">{t('common.loading')}</div>
        )}

        {loadError && (
          <div
            role="alert"
            data-testid="proxy-status-error"
            className="p-2 rounded-lg bg-destructive/10 text-destructive text-sm"
          >
            {loadError}
          </div>
        )}

        {status && (
          <>
            <SettingsRow
              label={t('proxy.enabled')}
              control={
                <span
                  data-testid="proxy-status-enabled"
                  className={cn(
                    BADGE,
                    status.enabled
                      ? 'bg-status-success/15 text-status-success'
                      : 'bg-muted text-muted-foreground',
                  )}
                >
                  {status.enabled ? t('proxy.enabled') : t('proxy.disabled')}
                </span>
              }
            />

            <SettingsRow
              label={t('proxy.source')}
              control={
                <span data-testid="proxy-status-source" className="text-sm text-foreground">
                  {t(`proxy.source.${status.source}`)}
                </span>
              }
            />

            <SettingsRow
              label={t('proxy.url')}
              control={
                <span
                  data-testid="proxy-status-url"
                  className="max-w-full break-all font-mono text-xs text-foreground"
                >
                  {status.url ?? '—'}
                </span>
              }
            />

            <SettingsRow
              label={t('proxy.noProxy')}
              control={
                <div
                  data-testid="proxy-status-no-proxy"
                  className="flex max-w-full flex-wrap justify-end gap-1.5"
                >
                  {status.noProxy.length === 0 ? (
                    <span className="text-sm text-muted-foreground">—</span>
                  ) : (
                    status.noProxy.map((entry) => (
                      <span
                        key={entry}
                        className="inline-flex max-w-full items-center rounded-full bg-interactive-hover px-2 py-0.5 font-mono text-xs text-foreground"
                      >
                        <span className="min-w-0 truncate">{entry}</span>
                      </span>
                    ))
                  )}
                </div>
              }
            />

            <SettingsRow
              label={t('proxy.fallbackDirect')}
              description={status.fallbackDirect ? t('proxy.fallbackDirectHint') : undefined}
              control={
                <span
                  data-testid="proxy-status-fallback"
                  className={cn(
                    BADGE,
                    status.fallbackDirect
                      ? 'bg-status-warning/15 text-status-warning'
                      : 'bg-muted text-muted-foreground',
                  )}
                >
                  {status.fallbackDirect ? t('proxy.enabled') : '—'}
                </span>
              }
            />

            <SettingsRow
              label={t('proxy.connectTimeout')}
              control={
                <span
                  data-testid="proxy-status-timeout"
                  className="text-sm text-foreground tabular-nums"
                >
                  {t('proxy.connectTimeoutValue', { ms: status.connectTimeoutMs })}
                </span>
              }
            />

            <div
              data-testid="proxy-status-restart"
              className="flex items-start gap-2 rounded-lg bg-status-warning/10 p-2 text-xs text-status-warning"
            >
              <Icon name="refresh" className="mt-0.5 size-3.5 shrink-0" />
              <span className="min-w-0 break-words">{t('proxy.restartRequired')}</span>
            </div>

            <div className="space-y-2 min-w-0 border-t border-border/60 pt-3">
              <Button
                variant="outline"
                size="sm"
                className="shrink-0"
                onClick={() => void handleCheck()}
                disabled={checking}
                data-testid="proxy-check-button"
              >
                <Icon name="link" className="size-3.5" />
                {checking ? t('proxy.checking') : t('proxy.check')}
              </Button>

              {checkError && (
                <div
                  role="alert"
                  data-testid="proxy-check-error"
                  className="rounded-lg bg-destructive/10 p-2 text-xs text-destructive"
                >
                  {t('proxy.checkError', { error: checkError })}
                </div>
              )}

              {result && (
                <div
                  role="status"
                  data-testid="proxy-check-result"
                  className={cn(
                    'space-y-1 rounded-lg p-2 text-xs',
                    result.reachable
                      ? 'bg-status-success/10 text-status-success'
                      : 'bg-destructive/10 text-destructive',
                  )}
                >
                  <div className="font-medium">
                    {result.reachable ? t('proxy.reachable') : t('proxy.unreachable')}
                  </div>
                  {result.reachable && (
                    <div className="tabular-nums">
                      {t('proxy.latency', {
                        latency: Math.max(0, Math.round(result.latencyMs ?? 0)),
                      })}
                    </div>
                  )}
                  <div>{t('proxy.authChallenge', { challenge: result.authChallenge })}</div>
                  {result.error && <div className="min-w-0 break-words">{result.error}</div>}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </SettingsSection>
  )
}
