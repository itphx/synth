import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useI18n } from '@/lib/i18n'
import { useAuthStore } from '@/stores/authStore'
import { useNotification } from '@/hooks/useNotification'
import { useStableItemKeys } from '@/hooks/useStableItemKeys'
import { confirm } from '@/lib/confirm'
import { formatDateTime } from '@/lib/formatDate'
import { Button } from '@/components/ui/button'
import { Icon } from '@/components/icon/Icon'
import { SelectContent, SelectItem } from '@/components/ui/select'
import { Toggle } from '@/components/ui/Toggle'
import {
  InfoField,
  KeyValueField,
  ListField,
  SelectField,
  SettingsPanel,
  SettingsSection,
  TextArea,
  TextField,
} from '@/components/ui/settings'
import {
  synthApi,
  type ExecutionImageWarmResult,
  type ExecutionPoolInfo,
  type ExecutionPoolsDto,
  type ExecutionProfileClass,
  type ExecutionProfileInfo,
  type ExecutionProfileMcpServer,
  type ExecutionProfileOrigin,
  type ExecutionProfileResources,
  type ExecutionProfilesDto,
  type ExecutionRuntimeProfile,
  type ExecutionRuntimeSettings,
  type ExecutionSettingsDto,
} from '@/lib/api/synthApi'

/** Статус HTTP-ошибки (`503`/`501` — провайдер пулов недоступен, `403` — нет прав). */
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

/** Класс профиля по умолчанию (не задан — `exec`). */
const DEFAULT_CLASS: ExecutionProfileClass = 'exec'

/**
 * Ресурсы профиля одной строкой: `limits` важнее `requests` (это потолок
 * контейнера). `null` — ресурсы неизвестны/пусты.
 */
function formatProfileResources(resources?: ExecutionProfileResources): string | null {
  const list = resources?.limits ?? resources?.requests
  if (!list) return null
  const parts: string[] = []
  for (const [key, value] of Object.entries(list)) {
    if (!value) continue
    parts.push(`${RESOURCE_LABELS[key] ?? key} ${value}`)
  }
  return parts.length > 0 ? parts.join(' · ') : null
}

/** Короткие подписи известных ресурсов (произвольные ключи — как есть). */
const RESOURCE_LABELS: Record<string, string> = {
  cpu: 'cpu',
  memory: 'mem',
  ephemeralStorage: 'ephemeral',
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

/** MCP-сервер профиля в форме: имя, команда, аргументы (строкой) и env. */
interface McpServerForm {
  name: string
  command: string
  args: string
  env: Record<string, string>
}

/** Toleration профиля в форме (пустая строка — поле не задано). */
interface TolerationForm {
  key: string
  operator: '' | 'Equal' | 'Exists'
  value: string
  effect: '' | 'NoSchedule' | 'PreferNoSchedule' | 'NoExecute'
}

/** Черновик формы профиля (create/edit). */
interface ProfileForm {
  description: string
  /** Класс «Исполнитель» (exec|both). */
  isExec: boolean
  /** Класс «Браузер» (browser|both). */
  isBrowser: boolean
  image: string
  urls: string[]
  network: '' | 'none' | 'restricted' | 'full'
  requests: Record<string, string>
  limits: Record<string, string>
  runtimeClass: string
  annotations: Record<string, string>
  labels: Record<string, string>
  nodeSelector: Record<string, string>
  tolerations: TolerationForm[]
  affinity: string
  env: Record<string, string>
  readOnlyRootFilesystem: boolean
  mcpServers: McpServerForm[]
}

/** Запись каталога профилей: имя + профиль + происхождение + признак отключения. */
interface CatalogEntry {
  name: string
  profile: ExecutionRuntimeProfile
  origin: ExecutionProfileOrigin
  /** Config-профиль, отключённый через `disabledProfiles`. */
  disabled: boolean
}

/** Runtime-черновик: только перекрытия config-каталога. */
interface ExecutionDraft {
  defaultProfile?: string
  browserProfile?: string
  pooling?: ExecutionRuntimeSettings['pooling']
  fallback?: ExecutionRuntimeSettings['fallback']
  profiles: Record<string, ExecutionRuntimeProfile>
  disabledProfiles: string[]
}

const EMPTY_FORM: ProfileForm = {
  description: '',
  isExec: true,
  isBrowser: false,
  image: '',
  urls: [],
  network: '',
  requests: {},
  limits: {},
  runtimeClass: '',
  annotations: {},
  labels: {},
  nodeSelector: {},
  tolerations: [],
  affinity: '',
  env: {},
  readOnlyRootFilesystem: false,
  mcpServers: [],
}

/** MCP-сервер браузера по умолчанию (ADR-135: playwright-mcp в headless-режиме). */
const BROWSER_MCP_NAME = 'playwright-mcp'
const BROWSER_MCP_ARGS = '--headless --no-sandbox --executable-path /opt/synth/browser/chrome'

/** Класс профиля из его формы. */
function formClass(form: ProfileForm): ExecutionProfileClass {
  if (form.isExec && form.isBrowser) return 'both'
  if (form.isBrowser) return 'browser'
  return 'exec'
}

/** Разбор аргументов MCP-сервера: по строке либо по пробелу. */
function parseArgs(raw: string): string[] {
  const lines = raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  if (lines.length === 0) return []
  if (lines.length === 1) return lines[0]!.split(/\s+/).filter(Boolean)
  return lines
}

/** Профиль → черновик формы (значения, которых нет, — пустые). */
function formFromProfile(profile: ExecutionRuntimeProfile | undefined): ProfileForm {
  if (!profile) return { ...EMPTY_FORM }
  const profileClass = profile.class ?? DEFAULT_CLASS
  return {
    description: profile.description ?? '',
    isExec: profileClass === 'exec' || profileClass === 'both',
    isBrowser: profileClass === 'browser' || profileClass === 'both',
    image: profile.image ?? '',
    urls: [...(profile.url ?? [])],
    network: profile.network ?? '',
    requests: { ...(profile.resources?.requests ?? {}) },
    limits: { ...(profile.resources?.limits ?? {}) },
    runtimeClass: profile.runtimeClass ?? '',
    annotations: { ...(profile.annotations ?? {}) },
    labels: { ...(profile.labels ?? {}) },
    nodeSelector: { ...(profile.nodeSelector ?? {}) },
    tolerations: (profile.tolerations ?? []).map((toleration) => ({
      key: toleration.key ?? '',
      operator: toleration.operator ?? '',
      value: toleration.value ?? '',
      effect: toleration.effect ?? '',
    })),
    affinity: profile.affinity ? JSON.stringify(profile.affinity, null, 2) : '',
    env: { ...(profile.env ?? {}) },
    readOnlyRootFilesystem: profile.readOnlyRootFilesystem === true,
    mcpServers: (profile.mcpServers ?? []).map((server) => ({
      name: server.name,
      command: server.command ?? '',
      args: (server.args ?? []).join('\n'),
      env: { ...(server.env ?? {}) },
    })),
  }
}

/** Черновик формы → профиль каталога (пустые поля не попадают в раздел). */
function profileFromForm(form: ProfileForm): { profile: ExecutionRuntimeProfile; error?: string } {
  const profile: ExecutionRuntimeProfile = { class: formClass(form) }
  const description = form.description.trim()
  if (description) profile.description = description
  const image = form.image.trim()
  if (image) profile.image = image
  const urls = form.urls.map((url) => url.trim()).filter(Boolean)
  if (urls.length > 0) profile.url = urls
  if (form.network) profile.network = form.network

  const requests = cleanResourceList(form.requests)
  const limits = cleanResourceList(form.limits)
  if (Object.keys(requests).length > 0 || Object.keys(limits).length > 0) {
    profile.resources = {
      ...(Object.keys(requests).length > 0 ? { requests } : {}),
      ...(Object.keys(limits).length > 0 ? { limits } : {}),
    }
  }

  const runtimeClass = form.runtimeClass.trim()
  if (runtimeClass) profile.runtimeClass = runtimeClass
  if (Object.keys(form.annotations).length > 0) profile.annotations = { ...form.annotations }
  if (Object.keys(form.labels).length > 0) profile.labels = { ...form.labels }
  if (Object.keys(form.nodeSelector).length > 0) profile.nodeSelector = { ...form.nodeSelector }

  const tolerations = form.tolerations
    .map((toleration) => ({
      ...(toleration.key.trim() ? { key: toleration.key.trim() } : {}),
      ...(toleration.operator ? { operator: toleration.operator } : {}),
      ...(toleration.value.trim() ? { value: toleration.value.trim() } : {}),
      ...(toleration.effect ? { effect: toleration.effect } : {}),
    }))
    .filter((toleration) => Object.keys(toleration).length > 0)
  if (tolerations.length > 0) profile.tolerations = tolerations

  const affinityText = form.affinity.trim()
  if (affinityText) {
    try {
      const parsed: unknown = JSON.parse(affinityText)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { profile, error: 'affinity' }
      }
      profile.affinity = parsed as Record<string, unknown>
    } catch {
      return { profile, error: 'affinity' }
    }
  }

  if (Object.keys(form.env).length > 0) profile.env = { ...form.env }
  if (form.readOnlyRootFilesystem) profile.readOnlyRootFilesystem = true

  const mcpServers: ExecutionProfileMcpServer[] = form.mcpServers
    .map((server) => {
      const name = server.name.trim()
      if (!name) return null
      const entry: ExecutionProfileMcpServer = { name }
      const command = server.command.trim()
      if (command) entry.command = command
      const args = parseArgs(server.args)
      if (args.length > 0) entry.args = args
      if (Object.keys(server.env).length > 0) entry.env = { ...server.env }
      return entry
    })
    .filter((server): server is ExecutionProfileMcpServer => server !== null)
  if (mcpServers.length > 0) profile.mcpServers = mcpServers

  return { profile }
}

/** Список ресурсов: без пустых ключей и значений. */
function cleanResourceList(list: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(list)) {
    const trimmedKey = key.trim()
    const trimmedValue = value.trim()
    if (!trimmedKey || !trimmedValue) continue
    out[trimmedKey] = trimmedValue
  }
  return out
}

/** Уникальное имя копии профиля (`<name>-copy`, `<name>-copy-2`, …). */
function duplicateName(name: string, taken: Iterable<string>): string {
  const used = new Set(taken)
  const base = `${name}-copy`
  if (!used.has(base)) return base
  for (let i = 2; i < 100; i += 1) {
    const candidate = `${base}-${i}`
    if (!used.has(candidate)) return candidate
  }
  return `${base}-${Date.now()}`
}

/**
 * PROP-135 слайс 6b-2a: админ-раздел «Исполнение» — эффективные провайдер,
 * пулинг, runtime-каталог профилей (с правкой) и живые пулы
 * (`drain`/`release`).
 *
 * API — `GET /api/v2/execution/profiles`, `GET /api/v2/execution/pools`,
 * `POST /api/v2/execution/pools/:key/drain`, `DELETE /api/v2/execution/pools/:key`,
 * `POST /api/v2/execution/images/warm`,
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
  // restartRequired, effective, defaults, profileOrigins, isOverridden}`.
  const [settings, setSettings] = useState<ExecutionSettingsDto | null>(null)
  const [draft, setDraft] = useState<ExecutionDraft | null>(null)
  const [settingsError, setSettingsError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [restarting, setRestarting] = useState(false)
  // Форма create/edit профиля: `null` — форма закрыта.
  const [editor, setEditor] = useState<{
    mode: 'create' | 'edit'
    name: string
    form: ProfileForm
  } | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const formRef = useRef<HTMLDivElement>(null)

  // Прогрев образов (ADR-135 Ф4b-2b).
  const [warmOpen, setWarmOpen] = useState(false)
  const [warmSelection, setWarmSelection] = useState<string[]>([])
  const [warmResults, setWarmResults] = useState<ExecutionImageWarmResult[] | null>(null)
  const [warming, setWarming] = useState(false)

  const [busyKey, setBusyKey] = useState<string | null>(null)

  const describeError = useCallback(
    (err: unknown, fallbackKey: string): string => {
      const status = statusOf(err)
      if (status === 503) return t('settings.execution.providerUnavailable')
      if (status === 501) return t('settings.execution.warm.unsupported')
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
      setDraft(draftFromDto(dto))
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

  // Скролл к форме после её монтирования (создание/правка/дублирование).
  useEffect(() => {
    if (!editor) return
    formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [editor?.mode, editor?.name])

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

  /**
   * Каталог профилей: эффективный (config ⊕ runtime) минус удалённые
   * runtime-профили, плюс новые (из черновика) и отключённые config-профили.
   *
   * Источник правок — **черновик**: удалённый runtime-профиль исчезает из
   * списка сразу, а изменённый показывается в своей (ещё не сохранённой)
   * редакции.
   */
  const catalogEntries = useMemo<CatalogEntry[]>(() => {
    if (!settings) return []
    const origins = settings.profileOrigins
    const savedProfiles = settings.saved?.profiles ?? {}
    const draftProfiles = draft?.profiles ?? {}
    const disabled = new Set(draft?.disabledProfiles ?? [])

    /** Происхождение профиля (старый сервер — выводим из сохранённой секции). */
    const originOf = (name: string): ExecutionProfileOrigin => {
      const origin = origins?.[name]
      if (origin === 'config' || origin === 'runtime') return origin
      return savedProfiles[name] !== undefined ? 'runtime' : 'config'
    }

    const order = Object.keys(settings.effective.profiles ?? {})
    for (const name of Object.keys(draftProfiles)) {
      if (!order.includes(name)) order.push(name)
    }

    const entries: CatalogEntry[] = []
    for (const name of order) {
      const origin = originOf(name)
      if (origin === 'config') {
        // Config-профиль: только показ (правка — через дублирование).
        const profile = settings.effective.profiles?.[name] ?? draftProfiles[name]
        if (!profile) continue
        entries.push({ name, profile: { ...profile }, origin, disabled: disabled.has(name) })
        continue
      }
      // Runtime-профиль: показываем, только если он есть в черновике
      // (удалённый профиль исчезает из списка сразу).
      const profile = draftProfiles[name]
      if (!profile) continue
      entries.push({ name, profile: { ...profile }, origin: 'runtime', disabled: false })
    }

    // Отключённые config-профили (в эффективном каталоге их уже нет).
    for (const name of disabled) {
      if (entries.some((entry) => entry.name === name)) continue
      const configProfile = settings.defaults.profiles?.[name]
      if (!configProfile) continue
      entries.push({
        name,
        profile: { ...configProfile },
        origin: 'config',
        disabled: true,
      })
    }
    return entries
  }, [settings, draft])

  /** Метаданные рабочего каталога — запасной источник (старый сервер). */
  const detailsByName = useMemo(() => {
    const map = new Map<string, ExecutionProfileInfo>()
    for (const info of profiles?.details ?? []) map.set(info.name, info)
    return map
  }, [profiles])

  /** Класс профиля: эффективный (из каталога) либо из метаданных рабочего каталога. */
  const classOf = useCallback(
    (entry: CatalogEntry): ExecutionProfileClass => {
      if (entry.profile.class) return entry.profile.class
      const detail = detailsByName.get(entry.name)
      if (detail?.class) return detail.class
      if (entry.name === settings?.effective.browserProfile) return 'browser'
      if ((profiles?.browserProfiles ?? []).includes(entry.name)) return 'browser'
      return 'exec'
    },
    [detailsByName, settings?.effective.browserProfile, profiles?.browserProfiles],
  )

  const defaultProfile = draft?.defaultProfile ?? settings?.effective.defaultProfile ?? ''
  const browserProfile = draft?.browserProfile ?? settings?.effective.browserProfile ?? ''

  /** Профиль нельзя удалить, пока он назначен по умолчанию. */
  const isProtected = (name: string): boolean => name === defaultProfile || name === browserProfile

  const updateDraft = (patch: Partial<ExecutionDraft>) => {
    setDraft((prev) => (prev ? { ...prev, ...patch } : prev))
  }

  /** Runtime-часть PUT: только перекрытия config-каталога (merge-семантика). */
  const buildPayload = useCallback((): ExecutionRuntimeSettings => {
    const source = draft
    if (!source) return { profiles: {}, disabledProfiles: [] }
    return {
      ...(source.defaultProfile !== undefined ? { defaultProfile: source.defaultProfile } : {}),
      ...(source.browserProfile !== undefined ? { browserProfile: source.browserProfile } : {}),
      ...(source.pooling !== undefined ? { pooling: source.pooling } : {}),
      ...(source.fallback !== undefined ? { fallback: source.fallback } : {}),
      profiles: source.profiles,
      disabledProfiles: source.disabledProfiles,
    }
  }, [draft])

  const handleSave = async () => {
    if (!draft || saving) return
    setSaving(true)
    try {
      await synthApi.saveExecutionSettings(buildPayload())
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

  /** Включение/отключение config-профиля (`disabledProfiles`). */
  const toggleProfileEnabled = (name: string, enabled: boolean) => {
    if (!draft) return
    const current = new Set(draft.disabledProfiles)
    if (enabled) current.delete(name)
    else current.add(name)
    updateDraft({ disabledProfiles: [...current] })
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
    const next = { ...draft.profiles }
    delete next[name]
    updateDraft({ profiles: next })
  }

  /** Копия config-профиля в runtime-каталоге: новое имя + форма с его значениями. */
  const handleDuplicateProfile = (entry: CatalogEntry) => {
    if (!draft) return
    const name = duplicateName(entry.name, [
      ...Object.keys(settings?.effective.profiles ?? {}),
      ...Object.keys(draft.profiles),
    ])
    setFormError(null)
    setAdvancedOpen(false)
    setEditor({ mode: 'create', name, form: formFromProfile(entry.profile) })
  }

  const openCreate = () => {
    setFormError(null)
    setAdvancedOpen(false)
    setEditor({ mode: 'create', name: '', form: { ...EMPTY_FORM } })
  }

  const openEdit = (entry: CatalogEntry) => {
    setFormError(null)
    setAdvancedOpen(false)
    setEditor({ mode: 'edit', name: entry.name, form: formFromProfile(entry.profile) })
  }

  /** Применение формы: профиль уходит в runtime-каталог (черновик, без PUT). */
  const applyEditor = () => {
    if (!editor || !draft) return
    const name = editor.name.trim()
    if (!name) return
    const { profile, error } = profileFromForm(editor.form)
    if (error) {
      setFormError(t('settings.execution.catalog.affinityInvalid'))
      return
    }
    setFormError(null)
    const next = { ...draft.profiles }
    next[name] = profile
    updateDraft({ profiles: next })
    setEditor(null)
  }

  /** Переключатель класса «Браузер»: у нового профиля — MCP-сервер браузера. */
  const toggleBrowserClass = (form: ProfileForm, value: boolean): ProfileForm => {
    const next = { ...form, isBrowser: value }
    if (value && form.mcpServers.length === 0) {
      next.mcpServers = [{ name: BROWSER_MCP_NAME, command: '', args: BROWSER_MCP_ARGS, env: {} }]
    }
    return next
  }

  /** Патч полей формы (функциональное обновление — правки не теряются). */
  const patchForm = useCallback((patch: Partial<ProfileForm>) => {
    setEditor((prev) => (prev ? { ...prev, form: { ...prev.form, ...patch } } : prev))
  }, [])

  /** Патч формы профиля целиком (имя/режим). */
  const patchEditor = useCallback((patch: Partial<{ name: string; form: ProfileForm }>) => {
    setEditor((prev) => (prev ? { ...prev, ...patch } : prev))
  }, [])

  /** Прогрев образов: собрать список образов из каталога профилей. */
  const warmImages = useMemo(() => {
    const images = new Set<string>()
    for (const entry of catalogEntries) {
      const image = entry.profile.image
      if (image) images.add(image)
    }
    return [...images]
  }, [catalogEntries])

  const openWarm = () => {
    setWarmResults(null)
    setWarmSelection(warmImages)
    setWarmOpen(true)
  }

  const handleWarm = async () => {
    if (warmSelection.length === 0 || warming) return
    setWarming(true)
    try {
      const response = await synthApi.warmExecutionImages(warmSelection)
      setWarmResults(response.results)
    } catch (err) {
      notify({
        text: describeError(err, 'settings.execution.warm.error'),
        type: 'error',
        category: 'error',
      })
    } finally {
      setWarming(false)
    }
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

  /** Профили, которыми можно назначить браузерный дефолт (класс browser|both). */
  const browserCandidates = catalogEntries.filter((entry) => {
    const profileClass = classOf(entry)
    return profileClass === 'browser' || profileClass === 'both'
  })

  /** Профили, которыми можно назначить дефолт исполнителя (класс exec|both). */
  const execCandidates = catalogEntries.filter((entry) => {
    const profileClass = classOf(entry)
    return profileClass === 'exec' || profileClass === 'both'
  })

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
            <>
              <Button
                variant="outline-muted"
                size="sm"
                onClick={openWarm}
                disabled={saving || warmImages.length === 0}
                data-testid="execution-warm-open"
              >
                <Icon name="flask" className="size-3.5" />
                {t('settings.execution.warm.button')}
              </Button>
              <Button
                variant="outline-muted"
                size="sm"
                onClick={openCreate}
                disabled={saving}
                data-testid="execution-catalog-create"
              >
                <Icon name="add" className="size-3.5" />
                {t('settings.execution.catalog.create')}
              </Button>
            </>
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

        {/* Прогрев образов: мини-список чекбоксов + итог по образам. */}
        {isAdmin && warmOpen && (
          <div
            className="flex flex-col gap-2 rounded-lg border border-border bg-surface-inset p-3"
            data-testid="execution-warm-panel"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-foreground">
                {t('settings.execution.warm.title')}
              </span>
              <Button
                variant="outline-muted"
                size="sm"
                onClick={() => setWarmOpen(false)}
                data-testid="execution-warm-close"
              >
                {t('settings.execution.catalog.cancel')}
              </Button>
            </div>
            {warmImages.length === 0 ? (
              <div className="text-xs text-muted-foreground" data-testid="execution-warm-empty">
                {t('settings.execution.warm.empty')}
              </div>
            ) : (
              <div className="flex flex-col gap-1.5" data-testid="execution-warm-list">
                {warmImages.map((image, index) => (
                  <label key={image} className="flex min-w-0 items-center gap-2 text-xs text-foreground">
                    <input
                      type="checkbox"
                      checked={warmSelection.includes(image)}
                      onChange={(e) =>
                        setWarmSelection((prev) =>
                          e.target.checked
                            ? [...prev, image]
                            : prev.filter((item) => item !== image),
                        )
                      }
                      data-testid={`execution-warm-image-${index}`}
                    />
                    <span className="min-w-0 break-all font-mono">{image}</span>
                  </label>
                ))}
              </div>
            )}
            <div className="flex items-center gap-2">
              <Button
                variant="primary"
                size="sm"
                onClick={() => void handleWarm()}
                disabled={warming || warmSelection.length === 0}
                data-testid="execution-warm-submit"
              >
                {t('settings.execution.warm.submit')}
              </Button>
            </div>
            {warmResults && (
              <ul className="flex flex-col gap-1" data-testid="execution-warm-results">
                {warmResults.map((result, index) => (
                  <li
                    key={result.image}
                    className="flex min-w-0 flex-col gap-0.5 text-[0.6875rem]"
                    data-testid={`execution-warm-result-${index}`}
                  >
                    <span className="min-w-0 break-all font-mono">{result.image}</span>
                    <span
                      className={
                        result.ok ? 'text-status-success' : 'text-destructive'
                      }
                    >
                      {result.ok
                        ? t('settings.execution.warm.ok', { nodes: result.nodes })
                        : t('settings.execution.warm.failed', { error: result.error ?? DASH })}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* Форма create/edit профиля — над списком карточек. */}
        {editor && (
          <div
            ref={formRef}
            className="flex flex-col gap-2 rounded-lg border border-border bg-surface-inset p-3"
            data-testid="execution-catalog-editor"
          >
            {formError && (
              <div role="alert" className="rounded-lg bg-destructive/10 p-2 text-xs text-destructive" data-testid="execution-catalog-form-error">
                {formError}
              </div>
            )}
            {editor.mode === 'create' && (
              <TextField
                label={t('settings.execution.catalog.name')}
                value={editor.name}
                onChange={(e) => patchEditor({ name: e.target.value })}
                placeholder="default"
                mono
                data-testid="execution-catalog-name"
              />
            )}
            <TextField
              label={t('settings.execution.profile.description')}
              value={editor.form.description}
              onChange={(e) => patchForm({ description: e.target.value })}
              data-testid="execution-catalog-description"
            />

            {/* Классы профиля: исполнитель и/или браузер. */}
            <div className="flex flex-col gap-2" data-testid="execution-catalog-class">
              <ToggleFieldRow
                label={t('settings.execution.catalog.classExec')}
                enabled={editor.form.isExec}
                onToggle={() =>
                  setEditor((prev) =>
                    prev
                      ? {
                          ...prev,
                          form: {
                            ...prev.form,
                            // Класс не может быть пустым: снятие последнего
                            // переключателя оставляет «Исполнитель».
                            isExec:
                              prev.form.isExec || prev.form.isBrowser ? !prev.form.isExec : true,
                          },
                        }
                      : prev,
                  )
                }
                testId="execution-catalog-class-exec"
              />
              <ToggleFieldRow
                label={t('settings.execution.catalog.classBrowser')}
                enabled={editor.form.isBrowser}
                onToggle={() =>
                  setEditor((prev) =>
                    prev ? { ...prev, form: toggleBrowserClass(prev.form, !prev.form.isBrowser) } : prev,
                  )
                }
                testId="execution-catalog-class-browser"
              />
            </div>

            <TextField
              label={t('settings.execution.catalog.image')}
              value={editor.form.image}
              onChange={(e) => patchForm({ image: e.target.value })}
              placeholder="registry.example/synth-executor:latest"
              mono
              data-testid="execution-catalog-image"
            />
            <ListField
              label={t('settings.execution.catalog.urls')}
              values={editor.form.urls}
              onChange={(next) => patchForm({ urls: next })}
              placeholder="https://executor:8080"
              variant="list"
            />

            <SelectField
              label={t('settings.execution.profile.network')}
              value={editor.form.network}
              onValueChange={(value) =>
                patchForm({ network: value as ProfileForm['network'] })
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
            <div className="text-[0.6875rem] text-muted-foreground" data-testid="execution-catalog-network-hint">
              {t('settings.execution.catalog.networkHint')}
            </div>

            {/* Ресурсы: произвольные ключи (cpu/memory, nvidia.com/gpu). */}
            <div className="flex flex-col gap-2">
              <KeyValueField
                label={`${t('settings.execution.catalog.requests')} · ${t('settings.execution.catalog.cpu')}/${t('settings.execution.catalog.memory')}`}
                value={editor.form.requests}
                onChange={(next) => patchForm({ requests: next })}
                testId="execution-catalog-requests"
              />
              <KeyValueField
                label={`${t('settings.execution.catalog.limits')} · ${t('settings.execution.catalog.cpu')}/${t('settings.execution.catalog.memory')}`}
                value={editor.form.limits}
                onChange={(next) => patchForm({ limits: next })}
                testId="execution-catalog-limits"
              />
              <Button
                variant="outline"
                size="sm"
                className="self-start"
                onClick={() =>
                  setEditor((prev) =>
                    prev
                      ? {
                          ...prev,
                          form: {
                            ...prev.form,
                            requests: { cpu: '500m', memory: '512Mi', ...prev.form.requests },
                            limits: { cpu: '2', memory: '4Gi', ...prev.form.limits },
                          },
                        }
                      : prev,
                  )
                }
                data-testid="execution-catalog-resource-preset"
              >
                {t('settings.execution.catalog.resourcePreset')}
              </Button>
            </div>

            {/* MCP-серверы профиля. */}
            <McpServersEditor
              servers={editor.form.mcpServers}
              onChange={(next) => patchForm({ mcpServers: next })}
            />

            {/* Дополнительные поля (свёрнуты). */}
            <div className="flex flex-col gap-2">
              <Button
                variant="outline-muted"
                size="sm"
                className="self-start"
                onClick={() => setAdvancedOpen((prev) => !prev)}
                data-testid="execution-catalog-advanced-toggle"
              >
                <Icon name={advancedOpen ? 'arrow-up-s' : 'arrow-down-s'} className="size-3.5" />
                {t('settings.execution.catalog.advanced')}
              </Button>
              {advancedOpen && (
                <div className="flex flex-col gap-2" data-testid="execution-catalog-advanced">
                  <div className="flex flex-col gap-1">
                    <TextField
                      label={t('settings.execution.profile.runtimeClass')}
                      value={editor.form.runtimeClass}
                      onChange={(e) => patchForm({ runtimeClass: e.target.value })}
                      placeholder="gvisor"
                      mono
                      data-testid="execution-catalog-runtime-class"
                    />
                    <div className="text-[0.6875rem] text-muted-foreground">
                      {t('settings.execution.catalog.runtimeClassHint')}
                    </div>
                  </div>
                  <KeyValueField
                    label={t('settings.execution.catalog.annotations')}
                    value={editor.form.annotations}
                    onChange={(next) => patchForm({ annotations: next })}
                    testId="execution-catalog-annotations"
                  />
                  <KeyValueField
                    label={t('settings.execution.catalog.labels')}
                    value={editor.form.labels}
                    onChange={(next) => patchForm({ labels: next })}
                    testId="execution-catalog-labels"
                  />
                  <KeyValueField
                    label={t('settings.execution.catalog.nodeSelector')}
                    value={editor.form.nodeSelector}
                    onChange={(next) => patchForm({ nodeSelector: next })}
                    testId="execution-catalog-node-selector"
                  />
                  <TolerationsEditor
                    tolerations={editor.form.tolerations}
                    onChange={(next) => patchForm({ tolerations: next })}
                  />
                  <TextArea
                    label={t('settings.execution.catalog.affinity')}
                    value={editor.form.affinity}
                    onChange={(e) => patchForm({ affinity: e.target.value })}
                    placeholder='{"nodeAffinity": {}}'
                    mono
                    rows={4}
                    data-testid="execution-catalog-affinity"
                  />
                  <KeyValueField
                    label={t('settings.execution.catalog.env')}
                    value={editor.form.env}
                    onChange={(next) => patchForm({ env: next })}
                    testId="execution-catalog-env"
                  />
                  <ToggleFieldRow
                    label={t('settings.execution.catalog.readOnlyRootFilesystem')}
                    enabled={editor.form.readOnlyRootFilesystem}
                    onToggle={() =>
                      setEditor((prev) =>
                        prev
                          ? {
                              ...prev,
                              form: {
                                ...prev.form,
                                readOnlyRootFilesystem: !prev.form.readOnlyRootFilesystem,
                              },
                            }
                          : prev,
                      )
                    }
                    testId="execution-catalog-read-only-fs"
                  />
                </div>
              )}
            </div>

            <div className="flex items-center gap-2">
              <Button
                variant="primary"
                size="sm"
                onClick={applyEditor}
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
              const profileClass = classOf(entry)
              const isConfig = entry.origin === 'config'
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
                    {(profileClass === 'exec' || profileClass === 'both') && (
                      <span
                        className={`${BADGE} bg-primary/15 text-primary`}
                        data-testid={`execution-catalog-profile-${index}-class-exec`}
                      >
                        {t('settings.execution.catalog.classExec')}
                      </span>
                    )}
                    {(profileClass === 'browser' || profileClass === 'both') && (
                      <span
                        className={`${BADGE} bg-secondary/15 text-secondary-foreground`}
                        data-testid={`execution-catalog-profile-${index}-class-browser`}
                      >
                        {t('settings.execution.catalog.classBrowser')}
                      </span>
                    )}
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
                    {isConfig && (
                      <span
                        className={`${BADGE} bg-muted text-muted-foreground`}
                        data-testid={`execution-catalog-profile-${index}-config-badge`}
                      >
                        {t('settings.execution.catalog.configBadge')}
                      </span>
                    )}
                    {entry.disabled && (
                      <span
                        className={`${BADGE} bg-destructive/15 text-destructive`}
                        data-testid={`execution-catalog-profile-${index}-disabled-badge`}
                      >
                        {t('settings.execution.catalog.disabledBadge')}
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
                      value={mcp && mcp.length > 0 ? mcp.map((server) => server.name).join(', ') : DASH}
                      mono
                    />
                  </dl>
                  {isAdmin && (
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      {isConfig ? (
                        <>
                          <div
                            className="flex items-center gap-2"
                            data-testid={`execution-catalog-profile-${index}-enabled`}
                          >
                            <span className="text-[0.6875rem] text-muted-foreground">
                              {t('settings.execution.catalog.enabled')}
                            </span>
                            <Toggle
                              enabled={!entry.disabled}
                              onToggle={() => toggleProfileEnabled(name, entry.disabled)}
                              ariaLabel={t('settings.execution.catalog.enabled')}
                            />
                          </div>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleDuplicateProfile(entry)}
                            disabled={saving}
                            data-testid={`execution-catalog-profile-${index}-duplicate`}
                          >
                            <Icon name="file-copy" className="size-3.5" />
                            {t('settings.execution.catalog.duplicate')}
                          </Button>
                        </>
                      ) : (
                        <>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => openEdit(entry)}
                            disabled={saving}
                            data-testid={`execution-catalog-profile-${index}-edit`}
                          >
                            {t('settings.execution.catalog.edit')}
                          </Button>
                          <Button
                            variant="danger"
                            size="sm"
                            onClick={() => void handleDeleteProfile(name)}
                            disabled={saving || isProtected(name)}
                            data-testid={`execution-catalog-profile-${index}-delete`}
                          >
                            {t('settings.execution.catalog.delete')}
                          </Button>
                        </>
                      )}
                      {name !== defaultProfile && (profileClass === 'exec' || profileClass === 'both') && (
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
                      {name !== browserProfile && (profileClass === 'browser' || profileClass === 'both') && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => updateDraft({ browserProfile: name })}
                          disabled={saving}
                          data-testid={`execution-catalog-profile-${index}-set-browser`}
                        >
                          {t('settings.execution.catalog.makeBrowserDefault')}
                        </Button>
                      )}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}

        {/* Дефолты: exec-профиль и браузерный профиль. */}
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
                {execCandidates.map((entry) => (
                  <SelectItem key={entry.name} value={entry.name}>
                    {entry.name}
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
                {browserCandidates.map((entry) => (
                  <SelectItem key={entry.name} value={entry.name}>
                    {entry.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </SelectField>
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

/** Строка «подпись + переключатель» (без обёртки `SettingsField`). */
function ToggleFieldRow({
  label,
  enabled,
  onToggle,
  testId,
}: {
  label: string
  enabled: boolean
  onToggle: () => void
  testId: string
}) {
  return (
    <div className="flex items-center justify-between gap-3" data-testid={testId}>
      <span className="text-sm text-foreground">{label}</span>
      <Toggle enabled={enabled} onToggle={onToggle} ariaLabel={label} />
    </div>
  )
}

/** Редактор MCP-серверов профиля: имя, команда, аргументы, env. */
function McpServersEditor({
  servers,
  onChange,
}: {
  servers: McpServerForm[]
  onChange: (next: McpServerForm[]) => void
}) {
  const { t } = useI18n()
  const itemKeys = useStableItemKeys(servers.length)

  const updateAt = (index: number, patch: Partial<McpServerForm>) => {
    onChange(servers.map((server, i) => (i === index ? { ...server, ...patch } : server)))
  }

  return (
    <div className="flex flex-col gap-2" data-testid="execution-catalog-mcp">
      <span className="text-sm font-medium text-foreground">{t('settings.execution.catalog.mcp')}</span>
      {servers.length === 0 && (
        <span className="text-xs text-muted-foreground" data-testid="execution-catalog-mcp-empty">
          {t('settings.execution.catalog.mcpEmpty')}
        </span>
      )}
      {servers.map((server, index) => (
        <div
          key={itemKeys[index]}
          className="flex flex-col gap-2 rounded-lg border border-border p-2"
          data-testid={`execution-catalog-mcp-row-${index}`}
        >
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <TextField
              label={t('settings.execution.catalog.mcpName')}
              value={server.name}
              onChange={(e) => updateAt(index, { name: e.target.value })}
              mono
              data-testid={`execution-catalog-mcp-${index}-name`}
            />
            <TextField
              label={t('settings.execution.catalog.mcpCommand')}
              value={server.command}
              onChange={(e) => updateAt(index, { command: e.target.value })}
              mono
              data-testid={`execution-catalog-mcp-${index}-command`}
            />
          </div>
          <TextArea
            label={t('settings.execution.catalog.mcpArgs')}
            value={server.args}
            onChange={(e) => updateAt(index, { args: e.target.value })}
            placeholder="--flag value"
            mono
            rows={2}
            data-testid={`execution-catalog-mcp-${index}-args`}
          />
          <KeyValueField
            label={t('settings.execution.catalog.mcpEnv')}
            value={server.env}
            onChange={(next) => updateAt(index, { env: next })}
            testId={`execution-catalog-mcp-${index}-env`}
          />
          <Button
            variant="ghost"
            size="sm"
            className="self-start"
            onClick={() => onChange(servers.filter((_, i) => i !== index))}
            data-testid={`execution-catalog-mcp-${index}-remove`}
          >
            {t('settings.execution.catalog.mcpRemove')}
          </Button>
        </div>
      ))}
      <Button
        variant="outline"
        size="sm"
        className="self-start"
        onClick={() => onChange([...servers, { name: '', command: '', args: '', env: {} }])}
        data-testid="execution-catalog-mcp-add"
      >
        <Icon name="add" className="size-3.5" />
        {t('settings.execution.catalog.mcpAdd')}
      </Button>
    </div>
  )
}

/** Редактор toleration'ов профиля (key/operator/value/effect). */
function TolerationsEditor({
  tolerations,
  onChange,
}: {
  tolerations: TolerationForm[]
  onChange: (next: TolerationForm[]) => void
}) {
  const { t } = useI18n()
  const itemKeys = useStableItemKeys(tolerations.length)

  const updateAt = (index: number, patch: Partial<TolerationForm>) => {
    onChange(tolerations.map((toleration, i) => (i === index ? { ...toleration, ...patch } : toleration)))
  }

  return (
    <div className="flex flex-col gap-2" data-testid="execution-catalog-tolerations">
      <span className="text-sm font-medium text-foreground">
        {t('settings.execution.catalog.tolerations')}
      </span>
      {tolerations.map((toleration, index) => (
        <div
          key={itemKeys[index]}
          className="grid grid-cols-1 gap-2 sm:grid-cols-2"
          data-testid={`execution-catalog-toleration-${index}`}
        >
          <TextField
            label={t('settings.execution.catalog.tolerationKey')}
            value={toleration.key}
            onChange={(e) => updateAt(index, { key: e.target.value })}
            mono
            data-testid={`execution-catalog-toleration-${index}-key`}
          />
          <SelectField
            label={t('settings.execution.catalog.tolerationOperator')}
            value={toleration.operator}
            onValueChange={(value) =>
              updateAt(index, { operator: value as TolerationForm['operator'] })
            }
            ariaLabel={t('settings.execution.catalog.tolerationOperator')}
            triggerTestId={`execution-catalog-toleration-${index}-operator`}
          >
            <SelectContent>
              <SelectItem value="">{t('settings.execution.catalog.notSet')}</SelectItem>
              <SelectItem value="Equal">Equal</SelectItem>
              <SelectItem value="Exists">Exists</SelectItem>
            </SelectContent>
          </SelectField>
          <TextField
            label={t('settings.execution.catalog.tolerationValue')}
            value={toleration.value}
            onChange={(e) => updateAt(index, { value: e.target.value })}
            mono
            data-testid={`execution-catalog-toleration-${index}-value`}
          />
          <SelectField
            label={t('settings.execution.catalog.tolerationEffect')}
            value={toleration.effect}
            onValueChange={(value) =>
              updateAt(index, { effect: value as TolerationForm['effect'] })
            }
            ariaLabel={t('settings.execution.catalog.tolerationEffect')}
            triggerTestId={`execution-catalog-toleration-${index}-effect`}
          >
            <SelectContent>
              <SelectItem value="">{t('settings.execution.catalog.notSet')}</SelectItem>
              <SelectItem value="NoSchedule">NoSchedule</SelectItem>
              <SelectItem value="PreferNoSchedule">PreferNoSchedule</SelectItem>
              <SelectItem value="NoExecute">NoExecute</SelectItem>
            </SelectContent>
          </SelectField>
          <Button
            variant="ghost"
            size="sm"
            className="self-start"
            onClick={() => onChange(tolerations.filter((_, i) => i !== index))}
            data-testid={`execution-catalog-toleration-${index}-remove`}
          >
            {t('settings.execution.catalog.mcpRemove')}
          </Button>
        </div>
      ))}
      <Button
        variant="outline"
        size="sm"
        className="self-start"
        onClick={() => onChange([...tolerations, { key: '', operator: '', value: '', effect: '' }])}
        data-testid="execution-catalog-toleration-add"
      >
        <Icon name="add" className="size-3.5" />
        {t('settings.execution.catalog.tolerationAdd')}
      </Button>
    </div>
  )
}

/** Runtime-черновик из ответа `GET /settings/execution`. */
function draftFromDto(dto: ExecutionSettingsDto): ExecutionDraft {
  const saved = dto.saved
  return {
    ...(saved?.defaultProfile !== undefined ? { defaultProfile: saved.defaultProfile } : {}),
    ...(saved?.browserProfile !== undefined ? { browserProfile: saved.browserProfile } : {}),
    ...(saved?.pooling !== undefined ? { pooling: saved.pooling } : {}),
    ...(saved?.fallback !== undefined ? { fallback: saved.fallback } : {}),
    profiles: { ...(saved?.profiles ?? {}) },
    disabledProfiles: [...(saved?.disabledProfiles ?? dto.effective.disabledProfiles ?? [])],
  }
}
