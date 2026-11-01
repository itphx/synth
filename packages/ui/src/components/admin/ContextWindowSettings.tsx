import { useCallback, useEffect, useState } from 'react'

import { useI18n } from '@/lib/i18n'
import { useNotification } from '@/hooks/useNotification'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Icon } from '@/components/icon/Icon'
import {
  InfoField,
  SegmentedControl,
  SettingsItem,
  SettingsPanel,
  SettingsRow,
  SettingsSection,
} from '@/components/ui/settings'
import {
  DEFAULT_CONTEXT_WINDOW_POLICY,
  deleteContextWindowPolicy,
  fetchContextWindowSettings,
  putContextWindowPolicy,
  type ContextWindowPolicy,
  type ContextWindowSettings,
  type ContextWindowSettingsSource,
} from '@/lib/api/contextWindowSettings'

/** Порядок режимов политики в контроле и в описаниях. */
export const CONTEXT_WINDOW_POLICIES: readonly ContextWindowPolicy[] = ['off', 'warn', 'enforce']

/** Бейдж состояния — общий вид с админкой «Метрики». */
const BADGE = 'rounded px-1.5 py-0.5 text-[0.625rem] font-medium'

/** Цвет бейджа источника настройки. */
const SOURCE_BADGE_CLASS: Record<ContextWindowSettingsSource, string> = {
  env: 'bg-status-warning/15 text-status-warning',
  runtime: 'bg-primary/15 text-primary',
  config: 'bg-muted text-muted-foreground',
  default: 'bg-muted text-muted-foreground',
}

/** Статус HTTP-ошибки (для 409 «политика задана через env»). */
const statusOf = (err: unknown): number | undefined =>
  typeof (err as { status?: unknown })?.status === 'number'
    ? (err as { status: number }).status
    : undefined

export interface ContextWindowSettingsProps {
  /**
   * Встроенный режим: рендерятся только секции политики без собственного
   * `SettingsPanel` (заголовок/описание даёт страница «Управление контекстом»).
   */
  embedded?: boolean
}

/**
 * ADR-072: блок «Политика контекстного окна» — instance-wide политика
 * `context.windowPolicy` (`off` | `warn` | `enforce`).
 *
 * `GET/PUT/DELETE /api/v2/settings/context-window`: чтение, runtime-override
 * (применяется сразу — рестарт не требуется) и сброс к env/config/default.
 * При env-фиксации (`SYNTH_CONTEXT_WINDOW_POLICY`) сервер отвечает `409`,
 * контрол блокируется. Мутации — ADMIN (guard сервера).
 */
export function ContextWindowSettings({ embedded = false }: ContextWindowSettingsProps = {}) {
  const { t } = useI18n()
  const { notify } = useNotification()

  const [info, setInfo] = useState<ContextWindowSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  /**
   * Локальный признак env-фиксации: после `409` блокируем контрол, даже если
   * сервер не отдал `envLocked` в теле (старая сборка ядра).
   */
  const [envConflict, setEnvConflict] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const next = await fetchContextWindowSettings()
      setInfo(next)
      setEnvConflict(next.envLocked === true || next.source === 'env')
    } catch (err) {
      setLoadError(
        err instanceof Error && err.message
          ? err.message
          : t('settings.contextWindow.loadError'),
      )
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    void load()
  }, [load])

  const policy = info?.policy ?? DEFAULT_CONTEXT_WINDOW_POLICY
  const source: ContextWindowSettingsSource = info?.source ?? 'default'
  const defaults = info?.defaults ?? DEFAULT_CONTEXT_WINDOW_POLICY
  const locked = envConflict || info?.envLocked === true || source === 'env'
  const canReset = source === 'runtime' && !locked

  const handleSelect = useCallback(
    async (next: ContextWindowPolicy) => {
      if (!info || saving || locked || next === info.policy) return
      setSaving(true)
      setActionError(null)
      try {
        const updated = await putContextWindowPolicy(next)
        setInfo(updated)
        setEnvConflict(updated.envLocked === true || updated.source === 'env')
        notify({ text: t('settings.contextWindow.saved'), type: 'success', category: 'system' })
      } catch (err) {
        if (statusOf(err) === 409) {
          setEnvConflict(true)
          setActionError(t('settings.contextWindow.conflict'))
        } else {
          setActionError(
            t('settings.contextWindow.saveError', {
              error: err instanceof Error ? err.message : t('common.error'),
            }),
          )
        }
      } finally {
        setSaving(false)
      }
    },
    [info, locked, notify, saving, t],
  )

  const handleReset = useCallback(async () => {
    if (saving || locked) return
    setSaving(true)
    setActionError(null)
    try {
      const updated = await deleteContextWindowPolicy()
      setInfo(updated)
      setEnvConflict(updated.envLocked === true || updated.source === 'env')
      notify({ text: t('settings.contextWindow.resetDone'), type: 'success', category: 'system' })
    } catch (err) {
      setActionError(
        t('settings.contextWindow.resetError', {
          error: err instanceof Error ? err.message : t('common.error'),
        }),
      )
    } finally {
      setSaving(false)
    }
  }, [locked, notify, saving, t])

  const content = (
    <>
      {/* 1. Политика: источник, три режима с описаниями, env-баннер, сброс */}
      <SettingsSection
        id="context-window-policy"
        title={t('settings.contextWindow.policy.title')}
        description={t('settings.contextWindow.policy.description')}
        tooltip={t('settings.help.contextWindow.section.context-window-policy')}
      >
        {loadError && (
          <div
            role="alert"
            data-testid="context-window-load-error"
            className="flex flex-wrap items-start justify-between gap-2 rounded-lg bg-destructive/10 p-3 text-sm text-destructive min-w-0"
          >
            <span className="min-w-0 break-words">{loadError}</span>
            <Button
              variant="outline"
              size="sm"
              className="shrink-0"
              onClick={() => void load()}
              disabled={loading}
              data-testid="context-window-retry"
            >
              <Icon name="refresh" className={cn('size-3.5', loading && 'animate-spin')} />
              {t('settings.contextWindow.retry')}
            </Button>
          </div>
        )}

        {loading && !info && (
          <div className="py-3 text-center text-xs text-muted-foreground" data-testid="context-window-loading">
            {t('common.loading')}
          </div>
        )}

        {info && (
          <>
            <div
              className="flex flex-wrap items-center gap-1.5 min-w-0"
              data-testid="context-window-badges"
            >
              <span
                data-testid="context-window-source-badge"
                className={cn(BADGE, SOURCE_BADGE_CLASS[source])}
              >
                {t(`settings.contextWindow.source.${source}`)}
              </span>
            </div>

            {locked && (
              <div
                role="status"
                data-testid="context-window-env-banner"
                className="flex items-start gap-2 rounded-lg bg-status-warning/10 p-3 text-xs text-status-warning min-w-0"
              >
                <Icon name="alert" className="mt-0.5 size-3.5 shrink-0" />
                <span className="min-w-0 break-words">
                  {t('settings.contextWindow.envBanner')}
                </span>
              </div>
            )}

            <div data-testid="context-window-policy">
              <SegmentedControl<ContextWindowPolicy>
                value={policy}
                onChange={(next) => void handleSelect(next)}
                disabled={locked || saving}
                ariaLabel={t('settings.contextWindow.policy.label')}
                options={CONTEXT_WINDOW_POLICIES.map((mode) => ({
                  value: mode,
                  label: t(`settings.contextWindow.mode.${mode}`),
                }))}
              />
            </div>

            <div className="space-y-2 min-w-0" data-testid="context-window-modes">
              {CONTEXT_WINDOW_POLICIES.map((mode) => {
                const active = mode === policy
                return (
                  <SettingsItem
                    key={mode}
                    className={cn(active && 'border-primary/40')}
                  >
                    <div
                      className="space-y-1 min-w-0"
                      data-testid={`context-window-mode-${mode}`}
                      data-active={active}
                    >
                      <div className="flex flex-wrap items-center gap-1.5 min-w-0">
                        <span
                          className={cn(
                            'text-sm font-medium min-w-0 break-words',
                            active ? 'text-foreground' : 'text-muted-foreground',
                          )}
                        >
                          {t(`settings.contextWindow.mode.${mode}`)}
                        </span>
                        {active && (
                          <span className={cn(BADGE, 'bg-primary/15 text-primary')}>
                            {t('settings.contextWindow.current')}
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground min-w-0 break-words">
                        {t(`settings.contextWindow.modeHint.${mode}`)}
                      </p>
                    </div>
                  </SettingsItem>
                )
              })}
            </div>

            {actionError && (
              <p
                role="alert"
                data-testid="context-window-action-error"
                className="text-xs text-destructive break-words"
              >
                {actionError}
              </p>
            )}

            {canReset && (
              <SettingsRow
                label={t('settings.contextWindow.reset')}
                description={t('settings.contextWindow.resetHint')}
                control={
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void handleReset()}
                    disabled={saving}
                    data-testid="context-window-reset"
                  >
                    <Icon name="refresh" className={cn('size-3.5', saving && 'animate-spin')} />
                    {t('settings.contextWindow.reset')}
                  </Button>
                }
              />
            )}
          </>
        )}
      </SettingsSection>

      {/* 2. Как это работает: источник окна и условие блокировки */}
      <SettingsSection
        id="context-window-hints"
        title={t('settings.contextWindow.hints.title')}
        description={t('settings.contextWindow.hints.description')}
        tooltip={t('settings.help.contextWindow.section.context-window-hints')}
        advanced
      >
        <p className="text-xs text-muted-foreground min-w-0 break-words">
          {t('settings.contextWindow.hints.window')}
        </p>
        <p className="text-xs text-muted-foreground min-w-0 break-words">
          {t('settings.contextWindow.hints.enforce')}
        </p>

        {info && (
          <div className="space-y-1.5 min-w-0" data-testid="context-window-defaults">
            <InfoField
              label={t('settings.contextWindow.field.source')}
              value={t(`settings.contextWindow.source.${source}`)}
            />
            <InfoField
              label={t('settings.contextWindow.field.defaults')}
              value={t(`settings.contextWindow.mode.${defaults}`)}
            />
          </div>
        )}
      </SettingsSection>
    </>
  )

  if (embedded) return content

  return (
    <SettingsPanel
      title={t('settings.contextWindow.title')}
      description={t('settings.contextWindow.description')}
    >
      {content}
    </SettingsPanel>
  )
}
