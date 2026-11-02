import { useCallback, useEffect, useState } from 'react'

import { useI18n } from '@/lib/i18n'
import { useNotification } from '@/hooks/useNotification'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Icon } from '@/components/icon/Icon'
import {
  NumberField,
  SettingsActions,
  SettingsPanel,
  SettingsSection,
} from '@/components/ui/settings'
import {
  agentsLimitsApi,
  type AgentsLimitsSettings,
  type AgentsLimitsSource,
} from '@/lib/api/agentsLimits'

const BADGE = 'rounded px-1.5 py-0.5 text-[0.625rem] font-medium'

const SOURCE_BADGE_CLASS: Record<AgentsLimitsSource, string> = {
  env: 'bg-status-warning/15 text-status-warning',
  runtime: 'bg-primary/15 text-primary',
  config: 'bg-muted text-muted-foreground',
  default: 'bg-muted text-muted-foreground',
}

const statusOf = (err: unknown): number | undefined =>
  typeof (err as { status?: unknown })?.status === 'number'
    ? (err as { status: number }).status
    : undefined

/**
 * ADM-072: «Пределы саб-агентов» — instance-wide бюджет промпта саб-агента
 * (`agents.subagentMaxInputTokens`, `0` — без лимита).
 *
 * `GET/PUT/DELETE /api/v2/settings/agents-limits`; применяется к следующим
 * прогонам без рестарта. При env-фиксации (`SYNTH_AGENTS_SUBAGENT_MAX_INPUT_TOKENS`)
 * сервер отвечает `409`, контрол блокируется. Мутации — ADMIN (guard сервера).
 */
export function AgentsLimitsSettings() {
  const { t } = useI18n()
  const { notify } = useNotification()

  const [info, setInfo] = useState<AgentsLimitsSettings | null>(null)
  const [draft, setDraft] = useState('0')
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [envConflict, setEnvConflict] = useState(false)

  const apply = useCallback((next: AgentsLimitsSettings) => {
    setInfo(next)
    setDraft(String(next.subagentMaxInputTokens))
    setEnvConflict(next.envLocked === true || next.source === 'env')
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      apply(await agentsLimitsApi.getAgentsLimits())
    } catch (err) {
      setLoadError(
        err instanceof Error && err.message
          ? err.message
          : t('settings.agentsLimits.loadError'),
      )
    } finally {
      setLoading(false)
    }
  }, [apply, t])

  useEffect(() => {
    void load()
  }, [load])

  const value = info?.subagentMaxInputTokens ?? 0
  const source: AgentsLimitsSource = info?.source ?? 'default'
  const locked = envConflict || info?.envLocked === true || source === 'env'
  const canReset = source === 'runtime' && !locked

  const parsed = Number(draft.trim())
  const valid = draft.trim() !== '' && Number.isInteger(parsed) && parsed >= 0
  const dirty = valid && parsed !== value

  const handleSave = useCallback(async () => {
    if (!info || saving || locked || !valid || !dirty) return
    setSaving(true)
    setActionError(null)
    try {
      apply(await agentsLimitsApi.setAgentsLimits(parsed))
      notify({ text: t('settings.agentsLimits.saved'), type: 'success', category: 'system' })
    } catch (err) {
      if (statusOf(err) === 409) {
        setEnvConflict(true)
        setActionError(t('settings.agentsLimits.conflict'))
      } else {
        setActionError(
          t('settings.agentsLimits.saveError', {
            error: err instanceof Error ? err.message : t('common.error'),
          }),
        )
      }
    } finally {
      setSaving(false)
    }
  }, [apply, dirty, info, locked, notify, parsed, saving, t, valid])

  const handleReset = useCallback(async () => {
    if (saving || locked) return
    setSaving(true)
    setActionError(null)
    try {
      apply(await agentsLimitsApi.resetAgentsLimits())
      notify({ text: t('settings.agentsLimits.resetDone'), type: 'success', category: 'system' })
    } catch (err) {
      setActionError(
        t('settings.agentsLimits.resetError', {
          error: err instanceof Error ? err.message : t('common.error'),
        }),
      )
    } finally {
      setSaving(false)
    }
  }, [apply, locked, notify, saving, t])

  return (
    <SettingsPanel
      title={t('settings.category.agentsLimits')}
      description={t('settings.agentsLimits.description')}
    >
      <SettingsSection
        id="agents-limits"
        title={t('settings.agentsLimits.field.title')}
        description={t('settings.agentsLimits.field.description')}
        tooltip={t('settings.help.agentsLimits.section.agents-limits')}
      >
        {loadError && (
          <div
            role="alert"
            data-testid="agents-limits-load-error"
            className="flex flex-wrap items-start justify-between gap-2 rounded-lg bg-destructive/10 p-3 text-sm text-destructive min-w-0"
          >
            <span className="min-w-0 break-words">{loadError}</span>
            <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
              <Icon name="refresh" className={cn('size-3.5', loading && 'animate-spin')} />
              {t('settings.agentsLimits.retry')}
            </Button>
          </div>
        )}

        {loading && !info && (
          <div className="py-3 text-center text-xs text-muted-foreground" data-testid="agents-limits-loading">
            {t('common.loading')}
          </div>
        )}

        {info && (
          <>
            <div className="flex flex-wrap items-center gap-1.5 min-w-0" data-testid="agents-limits-badges">
              <span
                data-testid="agents-limits-source-badge"
                className={cn(BADGE, SOURCE_BADGE_CLASS[source])}
              >
                {t(`settings.agentsLimits.source.${source}`)}
              </span>
            </div>

            {locked && (
              <div
                role="status"
                data-testid="agents-limits-env-banner"
                className="flex items-start gap-2 rounded-lg bg-status-warning/10 p-3 text-xs text-status-warning min-w-0"
              >
                <Icon name="alert" className="mt-0.5 size-3.5 shrink-0" />
                <span className="min-w-0 break-words">{t('settings.agentsLimits.envBanner')}</span>
              </div>
            )}

            <NumberField
              id="agents-limits-value"
              data-testid="agents-limits-input"
              label={t('settings.agentsLimits.field.label')}
              description={t('settings.agentsLimits.field.hint')}
              value={draft}
              min={0}
              step={1}
              disabled={locked || saving}
              error={
                !valid
                  ? t('settings.agentsLimits.field.invalid')
                  : undefined
              }
              onChange={(event) => setDraft(event.target.value)}
            />

            <p className="text-xs text-muted-foreground min-w-0">
              {t('settings.agentsLimits.field.defaults', { value: String(info.defaults) })}
            </p>

            {actionError && (
              <div role="alert" data-testid="agents-limits-action-error" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive min-w-0 break-words">
                {actionError}
              </div>
            )}

            <SettingsActions
              onSave={() => void handleSave()}
              onReset={() => void handleReset()}
              saveDisabled={!dirty || locked || saving}
              resetDisabled={!canReset || saving}
              saving={saving}
              resetLabel={t('settings.agentsLimits.reset')}
            />
          </>
        )}
      </SettingsSection>
    </SettingsPanel>
  )
}
