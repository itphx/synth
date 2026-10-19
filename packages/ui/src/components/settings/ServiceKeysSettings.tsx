import { useCallback, useEffect, useState } from 'react'

import type { ServiceApiKey, ServiceApiKeyCreated } from '@itphx/synth-shared'
import { GlobalRole, SERVICE_SCOPES, SERVICE_SCOPE_FAMILIES } from '@itphx/synth-shared/types'

import { synthApi } from '@/lib/api/synthApi'
import { useI18n } from '@/lib/i18n'
import { useNotification } from '@/hooks/useNotification'
import { confirm } from '@/lib/confirm'
import { formatDateTime } from '@/lib/formatDate'
import { useAuthStore } from '@/stores/authStore'
import { useProjectsStore } from '@/stores/projectsStore'
import { cn } from '@/lib/utils'
import { Icon } from '../icon/Icon'
import { Button } from '../ui/button'
import {
  MultiSelectField,
  NumberField,
  SettingsPanel,
  SettingsSection,
  TextField,
} from '../ui/settings'

/**
 * ADR-052: фоллбек-каталог scope'ов/ролей. Основной источник — серверный
 * `GET /service-keys/scopes` (каталог не компилируется в бандл); константы
 * используются, только если эндпоинт недоступен (гибрид/старый сервер).
 */
const FALLBACK_SCOPE_OPTIONS: string[] = [
  ...SERVICE_SCOPES,
  ...SERVICE_SCOPE_FAMILIES.map((family) => `${family}:*`),
]

/** ADR-052: фоллбек-набор ролей синтетического пользователя service-ключа. */
const FALLBACK_ROLE_OPTIONS = Object.values(GlobalRole) as GlobalRole[]

/**
 * ADR-052: тестовый curl обращения по service-key (read-only подсказка).
 * `GET /projects` требует scope `sessions:read`/`sessions:create` в семействе,
 * поэтому в примере — безопасный список проектов.
 */
export function buildServiceKeyCurl(key: string): string {
  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  return [
    `curl -X GET '${origin}/api/v2/projects' \\`,
    `  -H 'Authorization: Bearer ${key}' \\`,
    `  -H 'Content-Type: application/json'`,
  ].join('\n')
}

/** Статус ключа: отозван приоритетнее истёкшего срока. */
type KeyStatus = 'revoked' | 'expired' | 'active'

function keyStatus(key: ServiceApiKey, now: number): KeyStatus {
  if (key.revokedAt) return 'revoked'
  if (key.expiresAt && new Date(key.expiresAt).getTime() < now) return 'expired'
  return 'active'
}

/** `YYYY-MM-DD` (значение нативного `<input type="date">`) → ISO конца дня. */
function dateInputToIso(value: string): string | undefined {
  if (!value) return undefined
  const date = new Date(`${value}T23:59:59.999`)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

/** ISO-дата → `YYYY-MM-DD` для нативного поля даты (локальный календарь). */
function isoToDateInput(iso?: string | null): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/** Числовой черновик поля лимита → значение API: пусто → `undefined` (не слать поле). */
function parseOptionalInt(raw: string): number | undefined {
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  const value = Number.parseInt(trimmed, 10)
  return Number.isNaN(value) ? undefined : value
}

type ApiErrorLike = { status?: number; code?: string }

/**
 * ADR-052 (этап I) / ADR-072: админ-секция «Сервисные ключи» — CRUD scoped-ключей
 * инстанса (`/service-keys`). Список метаданных (label/prefix/статус/роли/scopes/
 * проектная проекция), создание (однократный показ секрета + curl), инлайн-редактор,
 * мягкий отзыв и удаление. Мутации — ADMIN (guard сервера); для остальных ролей —
 * read-only режим с пояснением.
 */
export function ServiceKeysSettings() {
  const { t, locale } = useI18n()
  const { notify } = useNotification()
  const userRoles = useAuthStore((s) => s.user?.roles) ?? []
  const canManage = userRoles.includes('ADMIN')

  const projects = useProjectsStore((s) => s.projects)
  const loadProjects = useProjectsStore((s) => s.loadProjects)

  const [keys, setKeys] = useState<ServiceApiKey[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // ADR-052: каталог scope'ов/ролей с сервера (`null` — ещё не загружен/ошибка → фоллбек).
  const [scopeCatalog, setScopeCatalog] = useState<string[] | null>(null)
  const [roleCatalog, setRoleCatalog] = useState<GlobalRole[] | null>(null)

  const [formOpen, setFormOpen] = useState(false)
  const [label, setLabel] = useState('')
  const [description, setDescription] = useState('')
  const [roles, setRoles] = useState<string[]>([])
  const [scopes, setScopes] = useState<string[]>([])
  const [allowedProjects, setAllowedProjects] = useState<string[]>([])
  const [rateLimit, setRateLimit] = useState('')
  const [expiresDate, setExpiresDate] = useState('')
  const [labelError, setLabelError] = useState<string | null>(null)
  const [scopesError, setScopesError] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  const [created, setCreated] = useState<ServiceApiKeyCreated | null>(null)
  const [pendingId, setPendingId] = useState<string | null>(null)

  const [editingId, setEditingId] = useState<string | null>(null)
  const [editLabel, setEditLabel] = useState('')
  const [editDescription, setEditDescription] = useState('')
  const [editRoles, setEditRoles] = useState<string[]>([])
  const [editScopes, setEditScopes] = useState<string[]>([])
  const [editAllowedProjects, setEditAllowedProjects] = useState<string[]>([])
  const [editRateLimit, setEditRateLimit] = useState('')
  const [editExpiresDate, setEditExpiresDate] = useState('')
  const [editLabelError, setEditLabelError] = useState<string | null>(null)
  const [editScopesError, setEditScopesError] = useState<string | null>(null)
  const [editError, setEditError] = useState<string | null>(null)
  const [editSaving, setEditSaving] = useState(false)

  const loadKeys = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const { keys: list } = await synthApi.getServiceKeys()
      setKeys(list)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('serviceKeys.loadError'))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    void loadKeys()
  }, [loadKeys])

  useEffect(() => {
    void loadProjects()
  }, [loadProjects])

  // ADR-052: каталог scope'ов/ролей берём с сервера (не компилируем в бандл).
  // Best-effort: при ошибке (гибрид/старый сервер) остаются shared-константы.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const catalog = await synthApi.getServiceKeyScopes()
        if (cancelled) return
        setScopeCatalog([
          ...catalog.scopes,
          ...catalog.families.map((family) => `${family}:*`),
        ])
        const known = Object.values(GlobalRole) as string[]
        setRoleCatalog(catalog.roles.filter((role): role is GlobalRole => known.includes(role)))
      } catch {
        // Фоллбек на FALLBACK_SCOPE_OPTIONS/FALLBACK_ROLE_OPTIONS — форма работает.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const projectOptions = projects.map((project) => ({ value: project.id, label: project.name }))
  const roleOptions = (roleCatalog ?? FALLBACK_ROLE_OPTIONS).map((role) => ({
    value: role as string,
    label: t(`serviceKeys.role.${role}`),
  }))
  const scopeOptions = (scopeCatalog ?? FALLBACK_SCOPE_OPTIONS).map((scope) => ({ value: scope, label: scope }))

  const projectName = (id: string) => projects.find((project) => project.id === id)?.name ?? id

  const resetCreateForm = () => {
    setLabel('')
    setDescription('')
    setRoles([])
    setScopes([])
    setAllowedProjects([])
    setRateLimit('')
    setExpiresDate('')
    setLabelError(null)
    setScopesError(null)
    setFormError(null)
  }

  const closeCreateForm = () => {
    setFormOpen(false)
    resetCreateForm()
  }

  const isConflict = (err: unknown): boolean => (err as ApiErrorLike)?.code === 'CONFLICT'

  const handleCreate = async () => {
    if (!label.trim()) {
      setLabelError(t('serviceKeys.labelRequired'))
      return
    }
    if (scopes.length === 0) {
      setScopesError(t('serviceKeys.scopesRequired'))
      return
    }
    setLabelError(null)
    setScopesError(null)
    setFormError(null)
    setCreating(true)
    try {
      const result = await synthApi.createServiceKey({
        label: label.trim(),
        description: description.trim() || undefined,
        roles: roles.length > 0 ? (roles as GlobalRole[]) : undefined,
        scopes,
        allowedProjects: allowedProjects.length > 0 ? allowedProjects : undefined,
        rateLimitPerMinute: parseOptionalInt(rateLimit),
        expiresAt: dateInputToIso(expiresDate),
      })
      setCreated(result)
      closeCreateForm()
      await loadKeys()
      notify({ text: t('serviceKeys.created'), type: 'success', category: 'system' })
    } catch (err) {
      if (isConflict(err)) {
        setLabelError(t('errors.conflict.serviceKeyLabel'))
      } else {
        setFormError(err instanceof Error ? err.message : t('common.error'))
      }
    } finally {
      setCreating(false)
    }
  }

  const openEdit = (key: ServiceApiKey) => {
    setEditingId(key.id)
    setEditLabel(key.label)
    setEditDescription(key.description ?? '')
    setEditRoles(key.roles ?? [])
    setEditScopes(key.scopes ?? [])
    setEditAllowedProjects(key.allowedProjects ?? [])
    setEditRateLimit(key.rateLimitPerMinute != null ? String(key.rateLimitPerMinute) : '')
    setEditExpiresDate(isoToDateInput(key.expiresAt))
    setEditLabelError(null)
    setEditScopesError(null)
    setEditError(null)
  }

  const closeEdit = () => {
    setEditingId(null)
    setEditLabelError(null)
    setEditScopesError(null)
    setEditError(null)
  }

  const handleEditSave = async (key: ServiceApiKey) => {
    if (!editLabel.trim()) {
      setEditLabelError(t('serviceKeys.labelRequired'))
      return
    }
    if (editScopes.length === 0) {
      setEditScopesError(t('serviceKeys.scopesRequired'))
      return
    }
    setEditLabelError(null)
    setEditScopesError(null)
    setEditError(null)
    setEditSaving(true)
    try {
      await synthApi.updateServiceKey(key.id, {
        label: editLabel.trim(),
        description: editDescription.trim() || null,
        roles: editRoles as GlobalRole[],
        scopes: editScopes,
        allowedProjects: editAllowedProjects.length > 0 ? editAllowedProjects : null,
        rateLimitPerMinute: parseOptionalInt(editRateLimit) ?? null,
        expiresAt: dateInputToIso(editExpiresDate) ?? null,
      })
      closeEdit()
      await loadKeys()
      notify({ text: t('serviceKeys.updated'), type: 'success', category: 'system' })
    } catch (err) {
      if (isConflict(err)) {
        setEditLabelError(t('errors.conflict.serviceKeyLabel'))
      } else {
        setEditError(err instanceof Error ? err.message : t('common.error'))
      }
    } finally {
      setEditSaving(false)
    }
  }

  const handleRevoke = async (key: ServiceApiKey) => {
    const ok = await confirm({
      title: t('serviceKeys.revokeTitle'),
      message: t('serviceKeys.revokeConfirm', { label: key.label }),
      confirmLabel: t('serviceKeys.revoke'),
      variant: 'warning',
      icon: 'shield',
    })
    if (!ok) return
    setPendingId(key.id)
    try {
      await synthApi.revokeServiceKey(key.id)
      await loadKeys()
      notify({ text: t('serviceKeys.revoked'), type: 'success', category: 'system' })
    } catch (err) {
      notify({
        text: t('serviceKeys.revokeError', {
          error: err instanceof Error ? err.message : t('common.error'),
        }),
        type: 'error',
        category: 'error',
      })
    } finally {
      setPendingId(null)
    }
  }

  const handleDelete = async (key: ServiceApiKey) => {
    const ok = await confirm({
      title: t('serviceKeys.deleteTitle'),
      message: t('serviceKeys.deleteConfirm', { label: key.label }),
      confirmLabel: t('common.delete'),
      variant: 'danger',
      icon: 'delete-bin',
    })
    if (!ok) return
    setPendingId(key.id)
    try {
      await synthApi.deleteServiceKey(key.id)
      if (created?.id === key.id) setCreated(null)
      await loadKeys()
      notify({ text: t('serviceKeys.deleted'), type: 'success', category: 'system' })
    } catch (err) {
      notify({
        text: t('serviceKeys.deleteError', {
          error: err instanceof Error ? err.message : t('common.error'),
        }),
        type: 'error',
        category: 'error',
      })
    } finally {
      setPendingId(null)
    }
  }

  const copy = (text: string) => {
    void navigator.clipboard.writeText(text).then(() => {
      notify({ text: t('serviceKeys.copied'), type: 'success', category: 'system' })
    })
  }

  const curl = buildServiceKeyCurl(created?.key ?? '<key>')
  const now = Date.now()
  const count = keys?.length ?? 0

  const statusBadge = (status: KeyStatus) => {
    const classes =
      status === 'active'
        ? 'bg-status-success/15 text-status-success'
        : status === 'expired'
          ? 'bg-status-warning/15 text-status-warning'
          : 'bg-muted text-muted-foreground'
    const text =
      status === 'active'
        ? t('serviceKeys.status.active')
        : status === 'expired'
          ? t('serviceKeys.status.expired')
          : t('serviceKeys.status.revoked')
    return (
      <span className={cn('shrink-0 rounded px-1.5 py-0.5 text-[0.625rem] font-medium', classes)}>
        {text}
      </span>
    )
  }

  const rolesSummary = (list: string[]) => (list.length > 0 ? list.join(', ') : t('serviceKeys.meta.noRoles'))
  const projectsSummary = (list?: string[]) =>
    list && list.length > 0
      ? list.map(projectName).join(', ')
      : t('serviceKeys.meta.allProjects')

  return (
    <SettingsPanel
      title={t('serviceKeys.title')}
      description={t('serviceKeys.description')}
      meta={t('serviceKeys.count', { count })}
    >
      {!canManage && (
        <SettingsSection>
          <div
            role="alert"
            data-testid="service-keys-readonly"
            className="rounded-lg bg-status-warning/10 p-3 text-sm text-status-warning"
          >
            {t('serviceKeys.readOnly')}
          </div>
        </SettingsSection>
      )}

      <SettingsSection
        id="service-keys-list"
        title={t('serviceKeys.listTitle')}
        description={t('serviceKeys.listDescription')}
        actions={
          canManage ? (
            <Button
              variant="outline"
              className="min-h-[var(--control-height)] shrink-0"
              onClick={() => {
                if (formOpen) {
                  closeCreateForm()
                } else {
                  resetCreateForm()
                  setFormOpen(true)
                }
              }}
              data-testid="service-keys-add"
            >
              <Icon name={formOpen ? 'close' : 'add'} className="size-3.5" />
              {formOpen ? t('common.cancel') : t('serviceKeys.add')}
            </Button>
          ) : undefined
        }
      >
        {error && (
          <div role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </div>
        )}

        {formOpen && canManage && (
          <div
            className="space-y-3 rounded-lg border border-border/60 bg-surface-inset p-3 min-w-0"
            data-testid="service-keys-form"
          >
            {formError && (
              <div role="alert" className="rounded-lg bg-destructive/10 p-2 text-xs text-destructive">
                {formError}
              </div>
            )}

            <TextField
              label={t('serviceKeys.form.label')}
              tooltip={t('serviceKeys.form.labelTooltip')}
              value={label}
              onChange={(e) => {
                setLabel(e.target.value)
                if (labelError) setLabelError(null)
              }}
              error={labelError ?? undefined}
              required
              id="service-keys-label"
              data-testid="service-keys-label"
            />

            <TextField
              label={t('serviceKeys.form.description')}
              tooltip={t('serviceKeys.form.descriptionTooltip')}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              id="service-keys-description"
              data-testid="service-keys-description"
            />

            <MultiSelectField
              label={t('serviceKeys.form.roles')}
              tooltip={t('serviceKeys.form.rolesTooltip')}
              values={roles}
              options={roleOptions}
              onChange={setRoles}
              emptyText={t('serviceKeys.form.rolesEmpty')}
              testIdPrefix="service-keys-role"
            />

            <MultiSelectField
              label={t('serviceKeys.form.scopes')}
              tooltip={t('serviceKeys.form.scopesTooltip')}
              values={scopes}
              options={scopeOptions}
              onChange={(next) => {
                setScopes(next)
                if (scopesError) setScopesError(null)
              }}
              error={scopesError ?? undefined}
              testIdPrefix="service-keys-scope"
            />

            <MultiSelectField
              label={t('serviceKeys.form.allowedProjects')}
              tooltip={t('serviceKeys.form.allowedProjectsTooltip')}
              values={allowedProjects}
              options={projectOptions}
              onChange={setAllowedProjects}
              emptyText={t('serviceKeys.form.allowedProjectsEmpty')}
              testIdPrefix="service-keys-project"
            />

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 min-w-0">
              <NumberField
                label={t('serviceKeys.form.rateLimit')}
                tooltip={t('serviceKeys.form.rateLimitTooltip')}
                min={0}
                step={1}
                value={rateLimit}
                onChange={(e) => setRateLimit(e.target.value)}
                placeholder="0"
                id="service-keys-rate"
                data-testid="service-keys-rate"
              />

              <TextField
                label={t('serviceKeys.form.expiresAt')}
                tooltip={t('serviceKeys.form.expiresAtTooltip')}
                type="date"
                value={expiresDate}
                onChange={(e) => setExpiresDate(e.target.value)}
                id="service-keys-expires"
                data-testid="service-keys-expires"
              />
            </div>

            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button
                variant="outline-muted"
                onClick={closeCreateForm}
                disabled={creating}
                data-testid="service-keys-cancel"
              >
                {t('common.cancel')}
              </Button>
              <Button
                variant="primary"
                onClick={() => void handleCreate()}
                disabled={creating}
                data-testid="service-keys-save"
              >
                {creating ? t('common.saving') : t('common.create')}
              </Button>
            </div>
          </div>
        )}

        {created && (
          <div
            className="space-y-2 rounded-lg border border-status-warning/40 bg-status-warning/10 p-3 min-w-0"
            data-testid="service-keys-secret"
          >
            <div className="flex items-start justify-between gap-2 min-w-0">
              <p className="break-words text-xs font-medium text-status-warning">
                {t('serviceKeys.secretWarning')}
              </p>
              <Button
                variant="ghost"
                size="sm"
                className="shrink-0 min-h-[var(--control-height)] min-w-[var(--control-height)]"
                onClick={() => setCreated(null)}
                title={t('common.close')}
                aria-label={t('common.close')}
                data-testid="service-keys-secret-close"
              >
                <Icon name="close" className="size-3.5" />
              </Button>
            </div>
            <div className="flex items-center gap-2 min-w-0">
              <code className="min-w-0 flex-1 break-all rounded bg-background px-2 py-1 font-mono text-xs">
                {created.key}
              </code>
              <Button
                variant="outline"
                size="sm"
                className="shrink-0 min-h-[var(--control-height)]"
                onClick={() => copy(created.key)}
                title={t('common.copy')}
                aria-label={t('common.copy')}
                data-testid="service-keys-copy"
              >
                <Icon name="file-copy" className="size-3.5" />
              </Button>
            </div>
            <div className="space-y-1 min-w-0">
              <div className="flex items-center justify-between gap-2 min-w-0">
                <span className="text-[0.6875rem] text-muted-foreground">
                  {t('serviceKeys.curlTitle')}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="shrink-0 min-h-[var(--control-height)] px-2"
                  onClick={() => copy(curl)}
                  title={t('common.copy')}
                  aria-label={t('common.copy')}
                  data-testid="service-keys-curl-copy"
                >
                  <Icon name="file-copy" className="size-3.5" />
                </Button>
              </div>
              <pre
                data-testid="service-keys-curl"
                className="max-h-40 overflow-auto break-all whitespace-pre-wrap rounded-lg border border-border/60 bg-surface-inset p-2 text-[0.6875rem]"
              >
                {curl}
              </pre>
            </div>
          </div>
        )}

        {loading && keys === null && (
          <div className="py-3 text-center text-xs text-muted-foreground">{t('common.loading')}</div>
        )}

        {keys && keys.length === 0 && (
          <div
            className="flex flex-col items-center gap-1 py-4 text-center text-muted-foreground"
            data-testid="service-keys-empty"
          >
            <Icon name="key" className="size-6 opacity-40" />
            <p className="text-xs">{t('serviceKeys.empty')}</p>
          </div>
        )}

        {keys && keys.length > 0 && (
          <ul className="space-y-2 min-w-0" data-testid="service-keys-list">
            {keys.map((key) => {
              const status = keyStatus(key, now)
              const editing = editingId === key.id
              return (
                <li
                  key={key.id}
                  data-testid={`service-keys-item-${key.id}`}
                  className={cn(
                    'space-y-2 rounded-lg border border-border/60 bg-surface-inset p-2.5 min-w-0',
                    editing && 'border-primary/40',
                  )}
                >
                  {editing && canManage ? (
                    <div className="space-y-3 min-w-0">
                      {editError && (
                        <div
                          role="alert"
                          className="rounded-lg bg-destructive/10 p-2 text-xs text-destructive"
                        >
                          {editError}
                        </div>
                      )}
                      <TextField
                        label={t('serviceKeys.form.label')}
                        tooltip={t('serviceKeys.form.labelTooltip')}
                        value={editLabel}
                        onChange={(e) => {
                          setEditLabel(e.target.value)
                          if (editLabelError) setEditLabelError(null)
                        }}
                        error={editLabelError ?? undefined}
                        required
                        id={`service-keys-edit-label-${key.id}`}
                        data-testid={`service-keys-edit-label-${key.id}`}
                      />
                      <TextField
                        label={t('serviceKeys.form.description')}
                        tooltip={t('serviceKeys.form.descriptionTooltip')}
                        value={editDescription}
                        onChange={(e) => setEditDescription(e.target.value)}
                        id={`service-keys-edit-description-${key.id}`}
                        data-testid={`service-keys-edit-description-${key.id}`}
                      />
                      <MultiSelectField
                        label={t('serviceKeys.form.roles')}
                        tooltip={t('serviceKeys.form.rolesTooltip')}
                        values={editRoles}
                        options={roleOptions}
                        onChange={setEditRoles}
                        emptyText={t('serviceKeys.form.rolesEmpty')}
                        testIdPrefix={`service-keys-edit-role-${key.id}`}
                      />
                      <MultiSelectField
                        label={t('serviceKeys.form.scopes')}
                        tooltip={t('serviceKeys.form.scopesTooltip')}
                        values={editScopes}
                        options={scopeOptions}
                        onChange={(next) => {
                          setEditScopes(next)
                          if (editScopesError) setEditScopesError(null)
                        }}
                        error={editScopesError ?? undefined}
                        testIdPrefix={`service-keys-edit-scope-${key.id}`}
                      />
                      <MultiSelectField
                        label={t('serviceKeys.form.allowedProjects')}
                        tooltip={t('serviceKeys.form.allowedProjectsTooltip')}
                        values={editAllowedProjects}
                        options={projectOptions}
                        onChange={setEditAllowedProjects}
                        emptyText={t('serviceKeys.form.allowedProjectsEmpty')}
                        testIdPrefix={`service-keys-edit-project-${key.id}`}
                      />
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 min-w-0">
                        <NumberField
                          label={t('serviceKeys.form.rateLimit')}
                          tooltip={t('serviceKeys.form.rateLimitTooltip')}
                          min={0}
                          step={1}
                          value={editRateLimit}
                          onChange={(e) => setEditRateLimit(e.target.value)}
                          placeholder="0"
                          id={`service-keys-edit-rate-${key.id}`}
                          data-testid={`service-keys-edit-rate-${key.id}`}
                        />
                        <TextField
                          label={t('serviceKeys.form.expiresAt')}
                          tooltip={t('serviceKeys.form.expiresAtTooltip')}
                          type="date"
                          value={editExpiresDate}
                          onChange={(e) => setEditExpiresDate(e.target.value)}
                          id={`service-keys-edit-expires-${key.id}`}
                          data-testid={`service-keys-edit-expires-${key.id}`}
                        />
                      </div>
                      <div className="flex flex-wrap items-center justify-end gap-2">
                        <Button
                          variant="outline-muted"
                          onClick={closeEdit}
                          disabled={editSaving}
                          data-testid={`service-keys-edit-cancel-${key.id}`}
                        >
                          {t('common.cancel')}
                        </Button>
                        <Button
                          variant="primary"
                          onClick={() => void handleEditSave(key)}
                          disabled={editSaving}
                          data-testid={`service-keys-edit-save-${key.id}`}
                        >
                          {editSaving ? t('common.saving') : t('common.save')}
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="flex flex-wrap items-start justify-between gap-2 min-w-0">
                        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                          <span className="min-w-0 break-words text-sm font-semibold text-foreground">
                            {key.label}
                          </span>
                          <code className="shrink-0 font-mono text-[0.6875rem] text-muted-foreground">
                            {key.prefix}
                          </code>
                          {statusBadge(status)}
                        </div>
                        {canManage && (
                          <div className="flex shrink-0 items-center gap-1">
                            <Button
                              variant="ghost"
                              size="sm"
                              className="min-h-[var(--control-height)] min-w-[var(--control-height)]"
                              onClick={() => openEdit(key)}
                              title={t('common.edit')}
                              aria-label={t('common.edit')}
                              data-testid={`service-keys-edit-${key.id}`}
                            >
                              <Icon name="edit-2" className="size-4" />
                            </Button>
                            {status !== 'revoked' && (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="min-h-[var(--control-height)] min-w-[var(--control-height)]"
                                onClick={() => void handleRevoke(key)}
                                disabled={pendingId === key.id}
                                title={t('serviceKeys.revoke')}
                                aria-label={t('serviceKeys.revoke')}
                                data-testid={`service-keys-revoke-${key.id}`}
                              >
                                <Icon name="shield" className="size-4" />
                              </Button>
                            )}
                            <Button
                              variant="ghost"
                              size="sm"
                              className="min-h-[var(--control-height)] min-w-[var(--control-height)] hover:text-destructive"
                              onClick={() => void handleDelete(key)}
                              disabled={pendingId === key.id}
                              title={t('common.delete')}
                              aria-label={t('common.delete')}
                              data-testid={`service-keys-delete-${key.id}`}
                            >
                              <Icon name="delete-bin" className="size-4" />
                            </Button>
                          </div>
                        )}
                      </div>

                      {key.description && (
                        <p className="break-words text-xs text-muted-foreground">{key.description}</p>
                      )}

                      <div className="space-y-1 min-w-0">
                        <div className="flex flex-wrap gap-1 min-w-0">
                          <span className="shrink-0 text-[0.6875rem] text-muted-foreground">
                            {t('serviceKeys.meta.roles')}:
                          </span>
                          <span className="min-w-0 break-words font-mono text-[0.6875rem] text-foreground">
                            {rolesSummary(key.roles)}
                          </span>
                        </div>
                        <div className="flex flex-wrap gap-1 min-w-0">
                          <span className="shrink-0 text-[0.6875rem] text-muted-foreground">
                            {t('serviceKeys.meta.scopes')}:
                          </span>
                          <span className="min-w-0 break-words font-mono text-[0.6875rem] text-foreground">
                            {key.scopes.join(', ')}
                          </span>
                        </div>
                        <div className="flex flex-wrap gap-1 min-w-0">
                          <span className="shrink-0 text-[0.6875rem] text-muted-foreground">
                            {t('serviceKeys.meta.projects')}:
                          </span>
                          <span className="min-w-0 break-words text-[0.6875rem] text-foreground">
                            {projectsSummary(key.allowedProjects)}
                          </span>
                        </div>
                      </div>

                      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[0.6875rem] text-muted-foreground min-w-0">
                        <span className="min-w-0 break-words">
                          {t('serviceKeys.meta.createdBy')}: {key.createdBy}
                        </span>
                        <span className="min-w-0 break-words">
                          {t('serviceKeys.meta.created')}: {formatDateTime(key.createdAt, locale)}
                        </span>
                        {key.lastUsedAt && (
                          <span className="min-w-0 break-words">
                            {t('serviceKeys.lastUsed')}: {formatDateTime(key.lastUsedAt, locale)}
                          </span>
                        )}
                        <span className="min-w-0 break-words">
                          {t('serviceKeys.meta.expires')}:{' '}
                          {key.expiresAt
                            ? formatDateTime(key.expiresAt, locale)
                            : t('serviceKeys.meta.noExpiry')}
                        </span>
                        <span className="min-w-0 break-words">
                          {t('serviceKeys.meta.rateLimit')}:{' '}
                          {key.rateLimitPerMinute != null
                            ? key.rateLimitPerMinute
                            : t('serviceKeys.meta.noLimit')}
                        </span>
                      </div>
                    </>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </SettingsSection>
    </SettingsPanel>
  )
}
