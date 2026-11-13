import { useCallback, useEffect, useMemo, useState } from 'react'

import { useI18n } from '@/lib/i18n'
import { useAuthStore } from '@/stores/authStore'
import { useNotification } from '@/hooks/useNotification'
import { confirm } from '@/lib/confirm'
import { formatDateTime } from '@/lib/formatDate'
import { Button } from '@/components/ui/button'
import { Icon } from '@/components/icon/Icon'
import { SelectContent, SelectItem } from '@/components/ui/select'
import {
  InfoField,
  KeyValueField,
  ListField,
  MultiSelectField,
  SelectField,
  SettingsPanel,
  SettingsSection,
  TextField,
} from '@/components/ui/settings'
import {
  synthApi,
  type ExecutionPoolInfo,
  type ExecutionPoolsDto,
  type ExecutionProfileInfo,
  type ExecutionProfileResources,
  type ExecutionProfilesDto,
  type ExecutionRuntimeProfile,
  type ExecutionRuntimeSettings,
  type ExecutionSettingsDto,
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

/** Черновик формы профиля (create/edit). */
interface ProfileForm {
  description: string
  image: string
  urls: string[]
  network: '' | 'none' | 'restricted' | 'full'
  requestsCpu: string
  requestsMemory: string
  limitsCpu: string
  limitsMemory: string
  runtimeClass: string
  env: Record<string, string>
}

/** Запись каталога профилей: имя + профиль + признак правки (runtime-каталог). */
interface CatalogEntry {
  name: string
  profile: ExecutionRuntimeProfile
  editable: boolean
}

const EMPTY_FORM: ProfileForm = {
  description: '',
  image: '',
  urls: [],
  network: '',
  requestsCpu: '',
  requestsMemory: '',
  limitsCpu: '',
  limitsMemory: '',
  runtimeClass: '',
  env: {},
}

/** Профиль → черновик формы (значения, которых нет, — пустые). */
function formFromProfile(profile: ExecutionRuntimeProfile | undefined): ProfileForm {
  if (!profile) return { ...EMPTY_FORM }
  const requests = profile.resources?.requests
  const limits = profile.resources?.limits
  return {
    description: profile.description ?? '',
    image: profile.image ?? '',
    urls: [...(profile.url ?? [])],
    network: profile.network ?? '',
    requestsCpu: requests?.cpu ?? '',
    requestsMemory: requests?.memory ?? '',
    limitsCpu: limits?.cpu ?? '',
    limitsMemory: limits?.memory ?? '',
    runtimeClass: profile.runtimeClass ?? '',
    env: { ...(profile.env ?? {}) },
  }
}

/** Черновик формы → профиль каталога (пустые поля не попадают в раздел). */
function profileFromForm(form: ProfileForm): ExecutionRuntimeProfile {
  const profile: ExecutionRuntimeProfile = {}
  const description = form.description.trim()
  if (description) profile.description = description
  const image = form.image.trim()
  if (image) profile.image = image
  const urls = form.urls.map((url) => url.trim()).filter(Boolean)
  if (urls.length > 0) profile.url = urls
  if (form.network) profile.network = form.network
  const requests: { cpu?: string; memory?: string } = {}
  if (form.requestsCpu.trim()) requests.cpu = form.requestsCpu.trim()
  if (form.requestsMemory.trim()) requests.memory = form.requestsMemory.trim()
  const limits: { cpu?: string; memory?: string } = {}
  if (form.limitsCpu.trim()) limits.cpu = form.limitsCpu.trim()
  if (form.limitsMemory.trim()) limits.memory = form.limitsMemory.trim()
  if (Object.keys(requests).length > 0 || Object.keys(limits).length > 0) {
    profile.resources = {
      ...(Object.keys(requests).length > 0 ? { requests } : {}),
      ...(Object.keys(limits).length > 0 ? { limits } : {}),
    }
  }
  const runtimeClass = form.runtimeClass.trim()
  if (runtimeClass) profile.runtimeClass = runtimeClass
  if (Object.keys(form.env).length > 0) profile.env = { ...form.env }
  return profile
}

/**
 * PROP-135 слайз 6b-2a: админ-раздел «Исполнение» — эффективные провайдер,
 * пулинг, runtime-каталог профилей (с правкой) и живые пулы
 * (`drain`/`release`).
 *
 * API — `GET /api/v2/execution/profiles`, `GET /api/v2/execution/pools`,
 * `POST /api/v2/execution/pools/:key/drain`, `DELETE /api/v2/execution/pools/:key`,
 * `GET/PUT/DELETE /api/v2/settings/execution` (runtime-каталог, ADMIN).
 *
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

  // Runtime-каталог (ADR-135): `GET /settings/execution` → `{saved, running,
  // restartRequired, effective, defaults, isOverridden}`.
  const [settings, setSettings] = useState<ExecutionSettingsDto | null>(null)
  const [draft, setDraft] = useState<ExecutionRuntimeSettings | null>(null)
  const [settingsError, setSettingsError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [restarting, setRestarting] = useState(false)
  // Форма create/edit профиля: `null` — форма закрыта.
  const [editor, setEditor] = useState<{ mode: 'create' | 'edit'; name: string; form: ProfileForm } | null>(
    null,
  )

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

  /** Runtime-каталог: читается ADMIN (в managed `GET /settings/execution` — ADMIN). */
  const loadSettings = useCallback(async () => {
    setSettingsError(null)
    try {
      const dto = await synthApi.getExecutionSettings()
      setSettings(dto)
      setDraft(dto.effective)
    } catch (err) {
      setSettings(null)
      setDraft(null)
      setSettingsError(describeError(err, 'settings.execution.catalog.loadError'))
    }
  }, [describeError])

  useEffect(() => {
    if (!canView) return
    void loadProfiles()
    void loadPools()
  }, [canView, loadProfiles, loadPools])

  useEffect(() => {
    if (!isAdmin) return
    void loadSettings()
  }, [isAdmin, loadSettings])

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

  /** Каталог профилей: runtime-секция (`effective.profiles`), иначе — рабочий. */
  const catalogEntries = useMemo<CatalogEntry[]>(() => {
    const fromDraft = Object.entries(draft?.profiles ?? {}).map(([name, profile]) => ({
      name,
      profile: { ...profile },
      editable: true,
    }))
    if (fromDraft.length > 0) return fromDraft
    // Fallback: рабочий каталог (секция ещё не задана) — только показ.
    return (profiles?.details ?? []).map((info) => ({
      name: info.name,
      profile: { ...info } as ExecutionRuntimeProfile,
      editable: false,
    }))
  }, [draft, profiles])

  /** Метаданные рабочего каталога — запасной источник (старый сервер). */
  const detailsByName = useMemo(() => {
    const map = new Map<string, ExecutionProfileInfo>()
    for (const info of profiles?.details ?? []) map.set(info.name, info)
    return map
  }, [profiles])

  const profileNames = useMemo(() => {
    const names = new Set<string>()
    for (const name of Object.keys(draft?.profiles ?? {})) names.add(name)
    for (const info of profiles?.details ?? []) names.add(info.name)
    for (const name of profiles?.profiles ?? []) names.add(name)
    if (draft?.defaultProfile) names.add(draft.defaultProfile)
    if (draft?.browserProfile) names.add(draft.browserProfile)
    return [...names]
  }, [draft, profiles])

  const defaultProfile = draft?.defaultProfile ?? ''
  const browserProfile = draft?.browserProfile ?? ''
  const browserProfiles = draft?.browserProfiles ?? []

  /** Профиль нельзя удалить, пока он назначен по умолчанию. */
  const isProtected = (name: string): boolean => name === defaultProfile || name === browserProfile

  const updateDraft = (patch: Partial<ExecutionRuntimeSettings>) => {
    setDraft((prev) => (prev ? { ...prev, ...patch } : prev))
  }

  const handleSave = async () => {
    if (!draft || saving) return
    setSaving(true)
    try {
      await synthApi.saveExecutionSettings(draft)
      notify({ text: t('settings.execution.catalog.saved'), type: 'success', category: 'system' })
      await loadSettings()
    } catch (err) {
      notify({
        text: describeError(err, 'settings.execution.catalog.saveError'),
        type: 'error',
        category: 'error',
      })
    } finally {
      setSaving(false)
    }
  }

  const handleReset = async () => {
    if (saving) return
    const ok = await confirm({
      title: t('settings.execution.catalog.resetTitle'),
      message: t('settings.execution.catalog.resetMessage'),
      variant: 'warning',
    })
    if (!ok) return
    setSaving(true)
    try {
      await synthApi.resetExecutionSettings()
      notify({ text: t('settings.execution.catalog.resetDone'), type: 'success', category: 'system' })
      await loadSettings()
    } catch (err) {
      notify({
        text: describeError(err, 'settings.execution.catalog.saveError'),
        type: 'error',
        category: 'error',
      })
    } finally {
      setSaving(false)
    }
  }

  const handleDeleteProfile = async (name: string) => {
    if (!draft || saving) return
    if (isProtected(name)) {
      notify({
        text: t('settings.execution.catalog.deleteProtected'),
        type: 'error',
        category: 'error',
      })
      return
    }
    const ok = await confirm({
      title: t('settings.execution.catalog.deleteTitle'),
      message: t('settings.execution.catalog.deleteMessage', { name }),
      variant: 'danger',
    })
    if (!ok) return
    const next = { ...(draft.profiles ?? {}) }
    delete next[name]
    updateDraft({ profiles: next })
  }


  /** «Перезапустить инстанс» (ADR-092): применяет runtime-каталог. */
  const handleRestart = async () => {
    if (restarting) return
    const ok = await confirm({
      title: t('settings.execution.restart.confirmTitle'),
      message: t('settings.execution.restart.confirm'),
      confirmLabel: t('settings.execution.restart.button'),
      variant: 'danger',
      icon: 'refresh',
    })
    if (!ok) return
    setRestarting(true)
    try {
      await synthApi.restartInstance()
      notify({ text: t('settings.execution.restart.started'), type: 'success', category: 'system' })
    } catch (err) {
      notify({
        text: t('settings.execution.restart.error', {
          error: err instanceof Error ? err.message : t('common.error'),
        }),
        type: 'error',
        category: 'error',
      })
    } finally {
      setRestarting(false)
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
  const actionsDisabled = provider !== 'http'
  // `inline` (standalone/hybrid) — исполнение в процессе: профилей и пулов нет,
  // поэтому вместо карточек и пулов показывается одно пояснение.
  const profilesNotApplicable = provider === 'inline'
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

      {/* Runtime-каталог профилей (ADR-135): правка — только ADMIN. */}
      <SettingsSection
        id="execution-catalog"
        title={t('settings.execution.catalog.title')}
        description={t('settings.execution.catalog.description')}
        actions={
          isAdmin ? (
            <Button
              variant="outline-muted"
              size="sm"
              onClick={() => setEditor({ mode: 'create', name: '', form: { ...EMPTY_FORM } })}
              disabled={saving}
              data-testid="execution-catalog-create"
            >
              <Icon name="add" className="size-3.5" />
              {t('settings.execution.catalog.create')}
            </Button>
          ) : undefined
        }
      >
        {profilesNotApplicable ? (
          <div className="text-xs text-muted-foreground" data-testid="execution-not-applicable">
            {t('settings.execution.notApplicable')}
          </div>
        ) : (
          <>
        {settingsError && (
          <div role="alert" className="rounded-lg bg-destructive/10 p-2 text-xs text-destructive" data-testid="execution-catalog-error">
            {settingsError}
          </div>
        )}

        {!isAdmin && (
          <div className="text-xs text-muted-foreground" data-testid="execution-catalog-readonly">
            {t('settings.execution.adminOnly')}
          </div>
        )}

        {isAdmin && settings?.restartRequired && (
          <div
            className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-status-warning/10 p-2 text-xs text-foreground"
            data-testid="execution-restart-banner"
          >
            <span className="min-w-0 break-words">{t('settings.execution.restartRequired')}</span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void handleRestart()}
              disabled={restarting}
              data-testid="execution-restart"
            >
              <Icon name="refresh" className="size-3.5" />
              {t('settings.execution.restart.button')}
            </Button>
          </div>
        )}

        {isAdmin && catalogEntries.length === 0 && (
          <div className="text-xs text-muted-foreground" data-testid="execution-catalog-empty">
            {t('settings.execution.catalog.empty')}
          </div>
        )}

        {isAdmin && catalogEntries.length > 0 && (
          <ul className="flex flex-col gap-2" data-testid="execution-catalog">
            {catalogEntries.map((entry, index) => {
              const { name, profile } = entry
              const resources = formatProfileResources(profile.resources)
              const detail = detailsByName.get(name)
              const description = profile.description ?? detail?.description
              const image = profile.image ?? detail?.image
              const network = profile.network ?? detail?.network
              const runtimeClass = profile.runtimeClass ?? detail?.runtimeClass
              const mcp = profile.mcpServers ?? detail?.mcpServers
              return (
                <li
                  key={name}
                  className="rounded-lg border border-border bg-surface-inset px-3 py-2"
                  data-testid={`execution-catalog-profile-${index}`}
                >
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className="min-w-0 break-all font-mono text-[0.75rem] text-foreground">
                      {name}
                    </span>
                    {name === defaultProfile && (
                      <span
                        className={`${BADGE} bg-primary/15 text-primary`}
                        data-testid={`execution-catalog-profile-${index}-default-badge`}
                      >
                        {t('settings.execution.profile.defaultBadge')}
                      </span>
                    )}
                    {name === browserProfile && (
                      <span
                        className={`${BADGE} bg-secondary/15 text-secondary-foreground`}
                        data-testid={`execution-catalog-profile-${index}-browser-badge`}
                      >
                        {t('settings.execution.catalog.browserBadge')}
                      </span>
                    )}
                  </div>
                  <dl className="mt-1.5 grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2">
                    <ProfileField
                      label={t('settings.execution.profile.description')}
                      value={description ?? DASH}
                    />
                    <ProfileField
                      label={t('settings.execution.profile.image')}
                      value={image ?? (profile.url && profile.url.length > 0 ? profile.url.join(', ') : DASH)}
                      mono
                    />
                    <ProfileField
                      label={t('settings.execution.profile.network')}
                      value={network ? t(`settings.execution.network.${network}`) : DASH}
                    />
                    <ProfileField
                      label={t('settings.execution.profile.resources')}
                      value={resources ?? DASH}
                      mono
                    />
                    <ProfileField
                      label={t('settings.execution.profile.runtimeClass')}
                      value={runtimeClass ?? DASH}
                      mono
                    />
                    <ProfileField
                      label={t('settings.execution.profile.mcp')}
                      value={mcp && mcp.length > 0 ? mcp.join(', ') : DASH}
                      mono
                    />
                  </dl>
                  {isAdmin && entry.editable && (
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setEditor({
                            mode: 'edit',
                            name,
                            form: formFromProfile(profile),
                          })
                        }}
                        disabled={saving}
                        data-testid={`execution-catalog-profile-${index}-edit`}
                      >
                        {t('settings.execution.catalog.edit')}
                      </Button>
                      {name !== defaultProfile && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => updateDraft({ defaultProfile: name })}
                          disabled={saving}
                          data-testid={`execution-catalog-profile-${index}-set-default`}
                        >
                          {t('settings.execution.catalog.makeDefault')}
                        </Button>
                      )}
                      {name !== browserProfile && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => updateDraft({
                            browserProfile: name,
                            // Явный список браузерных профилей должен содержать
                            // новый дефолт (сервер проверяет это условие).
                            browserProfiles:
                              browserProfiles.length > 0 && !browserProfiles.includes(name)
                                ? [...browserProfiles, name]
                                : browserProfiles,
                          })}
                          disabled={saving}
                          data-testid={`execution-catalog-profile-${index}-set-browser`}
                        >
                          {t('settings.execution.catalog.makeBrowserDefault')}
                        </Button>
                      )}
                      <Button
                        variant="danger"
                        size="sm"
                        onClick={() => void handleDeleteProfile(name)}
                        disabled={saving || isProtected(name)}
                        data-testid={`execution-catalog-profile-${index}-delete`}
                      >
                        {t('settings.execution.catalog.delete')}
                      </Button>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}

        {/* Форма create/edit профиля. */}
        {editor && (
          <div
            className="mt-2 flex flex-col gap-2 rounded-lg border border-border bg-surface-inset p-3"
            data-testid="execution-catalog-editor"
          >
            <TextField
              label={t('settings.execution.catalog.name')}
              value={editor.name}
              onChange={(e) => setEditor({ ...editor, name: e.target.value })}
              placeholder="default"
              mono
              disabled={editor.mode === 'edit'}
              data-testid="execution-catalog-name"
            />
            <TextField
              label={t('settings.execution.profile.description')}
              value={editor.form.description}
              onChange={(e) => setEditor({ ...editor, form: { ...editor.form, description: e.target.value } })}
              data-testid="execution-catalog-description"
            />
            <TextField
              label={t('settings.execution.catalog.image')}
              value={editor.form.image}
              onChange={(e) => setEditor({ ...editor, form: { ...editor.form, image: e.target.value } })}
              placeholder="registry.example/synth-executor:latest"
              mono
              data-testid="execution-catalog-image"
            />
            <ListField
              label={t('settings.execution.catalog.urls')}
              values={editor.form.urls}
              onChange={(next) => setEditor({ ...editor, form: { ...editor.form, urls: next } })}
              placeholder="https://executor:8080"
              variant="list"
            />
            <SelectField
              label={t('settings.execution.profile.network')}
              value={editor.form.network}
              onValueChange={(value) =>
                setEditor({
                  ...editor,
                  form: { ...editor.form, network: value as ProfileForm['network'] },
                })
              }
              ariaLabel={t('settings.execution.profile.network')}
              triggerTestId="execution-catalog-network"
            >
              <SelectContent>
                <SelectItem value="">{t('settings.execution.catalog.notSet')}</SelectItem>
                <SelectItem value="none">{t('settings.execution.network.none')}</SelectItem>
                <SelectItem value="restricted">{t('settings.execution.network.restricted')}</SelectItem>
                <SelectItem value="full">{t('settings.execution.network.full')}</SelectItem>
              </SelectContent>
            </SelectField>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <TextField
                label={`${t('settings.execution.catalog.requests')} · ${t('settings.execution.catalog.cpu')}`}
                value={editor.form.requestsCpu}
                onChange={(e) => setEditor({ ...editor, form: { ...editor.form, requestsCpu: e.target.value } })}
                placeholder="500m"
                mono
                data-testid="execution-catalog-requests-cpu"
              />
              <TextField
                label={`${t('settings.execution.catalog.requests')} · ${t('settings.execution.catalog.memory')}`}
                value={editor.form.requestsMemory}
                onChange={(e) =>
                  setEditor({ ...editor, form: { ...editor.form, requestsMemory: e.target.value } })
                }
                placeholder="512Mi"
                mono
                data-testid="execution-catalog-requests-memory"
              />
              <TextField
                label={`${t('settings.execution.catalog.limits')} · ${t('settings.execution.catalog.cpu')}`}
                value={editor.form.limitsCpu}
                onChange={(e) => setEditor({ ...editor, form: { ...editor.form, limitsCpu: e.target.value } })}
                placeholder="2"
                mono
                data-testid="execution-catalog-limits-cpu"
              />
              <TextField
                label={`${t('settings.execution.catalog.limits')} · ${t('settings.execution.catalog.memory')}`}
                value={editor.form.limitsMemory}
                onChange={(e) =>
                  setEditor({ ...editor, form: { ...editor.form, limitsMemory: e.target.value } })
                }
                placeholder="4Gi"
                mono
                data-testid="execution-catalog-limits-memory"
              />
            </div>
            <TextField
              label={t('settings.execution.profile.runtimeClass')}
              value={editor.form.runtimeClass}
              onChange={(e) => setEditor({ ...editor, form: { ...editor.form, runtimeClass: e.target.value } })}
              placeholder="gvisor"
              mono
              data-testid="execution-catalog-runtime-class"
            />
            <KeyValueField
              label={t('settings.execution.catalog.env')}
              value={editor.form.env}
              onChange={(next) => setEditor({ ...editor, form: { ...editor.form, env: next } })}
              testId="execution-catalog-env"
            />
            <div className="flex items-center gap-2">
              <Button
                variant="primary"
                size="sm"
                onClick={() => {
                  const name = editor.name.trim()
                  if (!name) return
                  const next = { ...(draft?.profiles ?? {}) }
                  next[name] = profileFromForm(editor.form)
                  updateDraft({ profiles: next })
                  setEditor(null)
                }}
                disabled={saving || editor.name.trim() === ''}
                data-testid="execution-catalog-apply"
              >
                {t('settings.execution.catalog.apply')}
              </Button>
              <Button
                variant="outline-muted"
                size="sm"
                onClick={() => setEditor(null)}
                data-testid="execution-catalog-cancel"
              >
                {t('settings.execution.catalog.cancel')}
              </Button>
            </div>
          </div>
        )}

        {/* Дефолты: exec-профиль, браузерный профиль и список браузерных. */}
        {isAdmin && (
          <div className="mt-3 flex flex-col gap-2" data-testid="execution-catalog-defaults">
            <SelectField
              label={t('settings.execution.catalog.defaultProfile')}
              value={defaultProfile}
              onValueChange={(value) => updateDraft({ defaultProfile: value })}
              ariaLabel={t('settings.execution.catalog.defaultProfile')}
              triggerTestId="execution-catalog-default-profile"
            >
              <SelectContent>
                {profileNames.map((name) => (
                  <SelectItem key={name} value={name}>
                    {name}
                  </SelectItem>
                ))}
              </SelectContent>
            </SelectField>
            <SelectField
              label={t('settings.execution.catalog.browserProfile')}
              value={browserProfile}
              onValueChange={(value) => updateDraft({ browserProfile: value })}
              ariaLabel={t('settings.execution.catalog.browserProfile')}
              triggerTestId="execution-catalog-browser-profile"
            >
              <SelectContent>
                {profileNames.map((name) => (
                  <SelectItem key={name} value={name}>
                    {name}
                  </SelectItem>
                ))}
              </SelectContent>
            </SelectField>
            <MultiSelectField
              label={t('settings.execution.catalog.browserProfiles')}
              values={browserProfiles}
              options={profileNames.map((name) => ({ value: name, label: name }))}
              onChange={(next) => updateDraft({ browserProfiles: next })}
              testIdPrefix="execution-catalog-browser-profiles"
            />
            <div className="flex items-center gap-2">
              <Button
                variant="primary"
                size="sm"
                onClick={() => void handleSave()}
                disabled={saving}
                data-testid="execution-catalog-save"
              >
                {t('settings.execution.catalog.save')}
              </Button>
              <Button
                variant="outline-muted"
                size="sm"
                onClick={() => void handleReset()}
                disabled={saving}
                data-testid="execution-catalog-reset"
              >
                {t('settings.execution.catalog.reset')}
              </Button>
            </div>
          </div>
        )}
          </>
        )}
      </SettingsSection>

      {!profilesNotApplicable && (
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
      )}
    </SettingsPanel>
  )
}
