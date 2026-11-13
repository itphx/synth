import { useCallback, useEffect, useState } from 'react'

import { useI18n } from '@/lib/i18n'
import { useAuthStore } from '@/stores/authStore'
import { useNotification } from '@/hooks/useNotification'
import { confirm } from '@/lib/confirm'
import { formatDateTime } from '@/lib/formatDate'
import { Button } from '@/components/ui/button'
import { Icon } from '@/components/icon/Icon'
import {
  InfoField,
  SettingsPanel,
  SettingsSection,
} from '@/components/ui/settings'
import {
  synthApi,
  type ExecutionPoolInfo,
  type ExecutionPoolsDto,
  type ExecutionProfileInfo,
  type ExecutionProfileResources,
  type ExecutionProfilesDto,
} from '@/lib/api/synthApi'

/** Статус HTTP-ошибки (`503` — провайдер пулов недоступен, `403` — нет прав). */
const statusOf = (err: unknown): number | undefined =>
  typeof (err as { status?: unknown })?.status === 'number'
    ? (err as { status: number }).status
    : undefined

const BADGE = 'rounded px-1.5 py-0.5 text-[0.625rem] font-medium'

const STATE_BADGE_CLASS: Record<ExecutionPoolInfo['state'], string> = {
  configured: 'bg-muted text-muted-foreground',
  ready: 'bg-status-success/15 text-status-success',
  draining: 'bg-status-warning/15 text-status-warning',
}

/** Подпись неизвестного поля профиля. */
const DASH = '—'

/**
 * Ресурсы профиля одной строкой: `limits` важнее `requests` (это потолок
 * контейнера). `null` — ресурсы неизвестны/пусты.
 */
function formatProfileResources(resources?: ExecutionProfileResources): string | null {
  const list = resources?.limits ?? resources?.requests
  if (!list) return null
  const parts: string[] = []
  if (list.cpu) parts.push(`cpu ${list.cpu}`)
  if (list.memory) parts.push(`mem ${list.memory}`)
  if (list.ephemeralStorage) parts.push(`ephemeral ${list.ephemeralStorage}`)
  return parts.length > 0 ? parts.join(' · ') : null
}

/** Поле карточки профиля: подпись + значение (неизвестное — «—»). */
function ProfileField({
  label,
  value,
  mono,
}: {
  label: string
  value: string
  mono?: boolean
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-[0.625rem] text-muted-foreground/70">{label}</dt>
      <dd
        className={`min-w-0 break-words text-[0.6875rem] text-foreground${mono ? ' font-mono' : ''}`}
      >
        {value}
      </dd>
    </div>
  )
}

/**
 * PROP-135 слайс 6b-2a: админ-раздел «Исполнение» — эффективные провайдер,
 * пулинг, профиль по умолчанию, каталог профилей и живые пулы (`drain`/`release`).
 *
 * API — `GET /api/v2/execution/profiles`, `GET /api/v2/execution/pools`,
 * `POST /api/v2/execution/pools/:key/drain`, `DELETE /api/v2/execution/pools/:key`.
 * Чтение — ADMIN/LEAD, мутации — только ADMIN (guard сервера); UI лишь прячет
 * недоступное. Секреты (адрес/токен пула) в DTO не приходят и не показываются.
 *
 * `503 EXECUTION_PROVIDER_UNAVAILABLE` — провайдер пулов недоступен (у `inline`
 * пулов с жизненным циклом нет); `403` — нет прав. Для `static`/`inline`
 * действия недоступны: пулы определяются конфигурацией либо живут в процессе.
 */
export function ExecutionSettings() {
  const { t, locale } = useI18n()
  const { notify } = useNotification()
  const roles = useAuthStore((s) => s.user?.roles) ?? []
  const isAdmin = roles.includes('ADMIN')
  const canView = isAdmin || roles.includes('LEAD')

  const [profiles, setProfiles] = useState<ExecutionProfilesDto | null>(null)
  const [profilesLoading, setProfilesLoading] = useState(false)
  const [profilesError, setProfilesError] = useState<string | null>(null)

  const [pools, setPools] = useState<ExecutionPoolsDto | null>(null)
  const [poolsLoading, setPoolsLoading] = useState(false)
  const [poolsError, setPoolsError] = useState<string | null>(null)

  const [busyKey, setBusyKey] = useState<string | null>(null)

  const describeError = useCallback(
    (err: unknown, fallbackKey: string): string => {
      const status = statusOf(err)
      if (status === 503) return t('settings.execution.providerUnavailable')
      if (status === 403) return t('settings.execution.forbidden')
      return t(fallbackKey, { error: err instanceof Error ? err.message : t('common.error') })
    },
    [t],
  )

  const loadProfiles = useCallback(async () => {
    setProfilesLoading(true)
    setProfilesError(null)
    try {
      setProfiles(await synthApi.getExecutionProfiles())
    } catch (err) {
      setProfilesError(describeError(err, 'settings.execution.loadError'))
    } finally {
      setProfilesLoading(false)
    }
  }, [describeError])

  const loadPools = useCallback(async () => {
    setPoolsLoading(true)
    setPoolsError(null)
    try {
      setPools(await synthApi.getExecutionPools())
    } catch (err) {
      setPoolsError(describeError(err, 'settings.execution.pools.loadError'))
    } finally {
      setPoolsLoading(false)
    }
  }, [describeError])

  useEffect(() => {
    if (!canView) return
    void loadProfiles()
    void loadPools()
  }, [canView, loadProfiles, loadPools])

  const runAction = async (
    pool: ExecutionPoolInfo,
    action: 'drain' | 'release',
  ): Promise<void> => {
    if (!pool.key || !isAdmin) return
    const ok = await confirm({
      title: t(`settings.execution.confirm.${action}Title`),
      message: t(`settings.execution.confirm.${action}Message`, { key: pool.key }),
      variant: 'warning',
    })
    if (!ok) return
    setBusyKey(pool.key)
    try {
      if (action === 'drain') await synthApi.drainExecutionPool(pool.key)
      else await synthApi.releaseExecutionPool(pool.key)
      notify({ text: t(`settings.execution.${action === 'drain' ? 'drained' : 'released'}`), type: 'success', category: 'system' })
      await loadPools()
    } catch (err) {
      notify({
        text: describeError(err, 'settings.execution.actionError'),
        type: 'error',
        category: 'error',
      })
    } finally {
      setBusyKey(null)
    }
  }

  if (!canView) {
    return (
      <SettingsPanel title={t('settings.category.execution')}>
        <SettingsSection id="execution-forbidden">
          <div className="text-xs text-muted-foreground" data-testid="execution-forbidden">
            {t('settings.execution.forbidden')}
          </div>
        </SettingsSection>
      </SettingsPanel>
    )
  }

  const provider = profiles?.provider ?? pools?.provider ?? null
  // Карточки профилей: детали с сервера, а профили без деталей (старый
  // provisioner/`static`) — хотя бы именем из каталога (не терять список).
  const profileItems: ExecutionProfileInfo[] = (() => {
    const details = profiles?.details ?? []
    const seen = new Set(details.map((info) => info.name))
    const missing = (profiles?.profiles ?? [])
      .filter((name) => !seen.has(name))
      .map((name) => ({ name }))
    return [...details, ...missing]
  })()
  const actionsDisabled = provider !== 'http'
  const actionsNote =
    provider === 'static'
      ? t('settings.execution.staticDisabled')
      : provider === 'inline'
        ? t('settings.execution.inlineDisabled')
        : null

  return (
    <SettingsPanel
      title={t('settings.category.execution')}
      description={t('settings.execution.description')}
    >
      <SettingsSection id="execution-summary" title={t('settings.execution.summary.title')}>
        <div className="space-y-1.5" data-testid="execution-summary">
          {profilesLoading && !profiles && (
            <div className="text-xs text-muted-foreground">{t('common.loading')}</div>
          )}
          {profilesError && (
            <div role="alert" className="flex items-start justify-between gap-2 rounded-lg bg-destructive/10 p-2 text-xs text-destructive" data-testid="execution-profiles-error">
              <span className="min-w-0 break-words">{profilesError}</span>
              <Button variant="outline-muted" size="sm" onClick={() => void loadProfiles()}>
                {t('settings.execution.retry')}
              </Button>
            </div>
          )}
          {profiles && (
            <>
              <InfoField
                label={t('settings.execution.provider')}
                valueNode={
                  <span className="inline-flex items-center gap-1.5">
                    <span className={BADGE}>{t(`settings.execution.provider.${profiles.provider}`)}</span>
                  </span>
                }
              />
              <InfoField
                label={t('settings.execution.pooling')}
                value={t(`settings.execution.pooling.${profiles.pooling}`)}
              />
              <InfoField label={t('settings.execution.defaultProfile')} value={profiles.defaultProfile} mono />
            </>
          )}
        </div>
      </SettingsSection>

      <SettingsSection id="execution-profiles" title={t('settings.execution.profiles.title')}>
        {profileItems.length > 0 ? (
          <ul className="flex flex-col gap-2" data-testid="execution-profiles">
            {profileItems.map((info, index) => {
              const resources = formatProfileResources(info.resources)
              return (
                <li
                  key={info.name}
                  className="rounded-lg border border-border bg-surface-inset px-3 py-2"
                  data-testid={`execution-profile-${index}`}
                >
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className="min-w-0 break-all font-mono text-[0.75rem] text-foreground">
                      {info.name}
                    </span>
                    {info.name === profiles?.defaultProfile && (
                      <span
                        className={`${BADGE} bg-primary/15 text-primary`}
                        data-testid={`execution-profile-${index}-default`}
                      >
                        {t('settings.execution.profile.defaultBadge')}
                      </span>
                    )}
                  </div>
                  <dl className="mt-1.5 grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2">
                    <ProfileField
                      label={t('settings.execution.profile.description')}
                      value={info.description ?? DASH}
                    />
                    <ProfileField
                      label={t('settings.execution.profile.image')}
                      value={info.image ?? DASH}
                      mono
                    />
                    <ProfileField
                      label={t('settings.execution.profile.network')}
                      value={
                        info.network
                          ? t(`settings.execution.network.${info.network}`)
                          : DASH
                      }
                    />
                    <ProfileField
                      label={t('settings.execution.profile.resources')}
                      value={resources ?? DASH}
                      mono
                    />
                    <ProfileField
                      label={t('settings.execution.profile.runtimeClass')}
                      value={info.runtimeClass ?? DASH}
                      mono
                    />
                    <ProfileField
                      label={t('settings.execution.profile.mcp')}
                      value={
                        info.mcpServers && info.mcpServers.length > 0
                          ? info.mcpServers.join(', ')
                          : DASH
                      }
                      mono
                    />
                  </dl>
                </li>
              )
            })}
          </ul>
        ) : (
          <div className="text-xs text-muted-foreground" data-testid="execution-profiles-empty">
            {t('settings.execution.profiles.empty')}
          </div>
        )}
      </SettingsSection>

      <SettingsSection
        id="execution-pools"
        title={t('settings.execution.pools.title')}
        description={actionsNote ?? undefined}
        actions={
          <Button
            variant="outline-muted"
            size="sm"
            onClick={() => void loadPools()}
            disabled={poolsLoading}
            data-testid="execution-pools-refresh"
          >
            <Icon name="refresh" className="size-3.5" />
            {t('settings.execution.refresh')}
          </Button>
        }
      >
        {poolsLoading && !pools && (
          <div className="text-xs text-muted-foreground">{t('common.loading')}</div>
        )}

        {poolsError && (
          <div role="alert" className="rounded-lg bg-destructive/10 p-2 text-xs text-destructive" data-testid="execution-pools-error">
            {poolsError}
          </div>
        )}

        {pools && pools.pools.length === 0 && !poolsError && (
          <div className="text-xs text-muted-foreground" data-testid="execution-pools-empty">
            {t('settings.execution.pools.empty')}
          </div>
        )}

        {pools && pools.pools.length > 0 && (
          <div className="flex flex-col gap-2" data-testid="execution-pools">
            {pools.pools.map((pool, index) => {
              const key = pool.key ?? ''
              const actionDisabled = actionsDisabled || !isAdmin || busyKey === key
              return (
                <div
                  key={key || `${pool.profile}-${index}`}
                  className="flex flex-col gap-1.5 rounded-lg border border-border bg-surface-inset px-3 py-2"
                  data-testid={`execution-pool-${index}`}
                >
                  <div className="flex flex-wrap items-center gap-2 min-w-0">
                    <span className="min-w-0 break-all font-mono text-[0.6875rem] text-foreground">
                      {key || t('settings.execution.pools.instanceKey')}
                    </span>
                    <span className={`${BADGE} ${STATE_BADGE_CLASS[pool.state]}`}>
                      {t(`settings.execution.pools.state.${pool.state}`)}
                    </span>
                    <span className="text-[0.6875rem] text-muted-foreground">{pool.profile}</span>
                  </div>
                  {(pool.createdAt || pool.lastUsedAt) && (
                    <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[0.625rem] text-muted-foreground/70">
                      {pool.createdAt && (
                        <span>
                          {t('settings.execution.pools.createdAt')}: {formatDateTime(pool.createdAt, locale)}
                        </span>
                      )}
                      {pool.lastUsedAt && (
                        <span>
                          {t('settings.execution.pools.lastUsedAt')}: {formatDateTime(pool.lastUsedAt, locale)}
                        </span>
                      )}
                    </div>
                  )}
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void runAction(pool, 'drain')}
                      disabled={actionDisabled}
                      data-testid={`execution-pool-${index}-drain`}
                    >
                      {t('settings.execution.pools.drain')}
                    </Button>
                    <Button
                      variant="danger"
                      size="sm"
                      onClick={() => void runAction(pool, 'release')}
                      disabled={actionDisabled}
                      data-testid={`execution-pool-${index}-release`}
                    >
                      {t('settings.execution.pools.release')}
                    </Button>
                    {isAdmin ? undefined : (
                      <span className="text-[0.625rem] text-muted-foreground/70" data-testid="execution-admin-only">
                        {t('settings.execution.adminOnly')}
                      </span>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </SettingsSection>
    </SettingsPanel>
  )
}
