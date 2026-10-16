import { useCallback, useEffect, useRef, useState } from 'react'

import { useI18n } from '@/lib/i18n'
import { useNotification } from '@/hooks/useNotification'
import { confirm } from '@/lib/confirm'
import { formatDateTime } from '@/lib/formatDate'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Icon } from '../icon/Icon'
import { SelectContent, SelectItem } from '../ui/select'
import { InfoField, SettingsPanel, SettingsSection, SelectField } from '../ui/settings'
import {
  synthApi,
  type DoctorCheck,
  type DoctorStatus,
  type MaintenanceAuditEntry,
  type MaintenanceBackupInfo,
  type MaintenanceStatus,
  type MigrationPlan,
  type RestoreValidation,
} from '@/lib/api/synthApi'

/** Символ статуса проверки `synth doctor` (паритет с CLI `renderDoctorResult`). */
const DOCTOR_GLYPH: Record<DoctorStatus, string> = { ok: '✓', warn: '⚠', fail: '✗' }

/** Цвет статуса проверки. */
const DOCTOR_CLASS: Record<DoctorStatus, string> = {
  ok: 'text-status-success',
  warn: 'text-status-warning',
  fail: 'text-destructive',
}

/**
 * ADR-091/ADR-092: человекочитаемый размер (1024-основание). Отдельная функция
 * (тестируемая) — в UI нет общей утилиты форматирования байт.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KiB', 'MiB', 'GiB', 'TiB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  const rounded = value >= 10 ? value.toFixed(0) : value.toFixed(1)
  return `${rounded} ${units[unit]}`
}

/** Имя архива из абсолютного пути запроса на восстановление (`.../backups/x.tar.gz` → `x.tar.gz`). */
export function archiveBaseName(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] || path
}

/** Бейдж статуса записи аудит-журнала обслуживания (ADR-092). */
const AUDIT_STATUS_CLASS: Record<MaintenanceAuditEntry['status'], string> = {
  ok: 'bg-status-success/15 text-status-success',
  failed: 'bg-destructive/15 text-destructive',
  scheduled: 'bg-status-warning/15 text-status-warning',
}

/**
 * ADR-092: краткая сводка `details` записи журнала — пары `ключ: значение`
 * через запятую (объекты/массивы — компактным JSON). Пусто — пустая строка.
 */
export function summarizeAuditDetails(details?: Record<string, unknown>): string {
  if (!details) return ''
  return Object.entries(details)
    .map(([key, value]) => {
      const text =
        value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value)
      return `${key}: ${text}`
    })
    .join(', ')
}

/** Опции снятия архива (ADR-091). */
type BackupOptions = { secrets: boolean; workspace: boolean; live: boolean }

/**
 * ADR-091/ADR-092 / ADR-072: админ-раздел «Обслуживание» — health инстанса
 * (`synth doctor`), миграции схемы данных, бэкапы и восстановление. Мутации —
 * ADMIN (guard сервера). Восстановление — офлайн-операция: `POST /restore` лишь
 * планирует её, применение — при следующем старте инстанса.
 */
export function MaintenanceSettings() {
  const { t, locale } = useI18n()
  const { notify } = useNotification()

  const [status, setStatus] = useState<MaintenanceStatus | null>(null)
  const [statusLoading, setStatusLoading] = useState(true)
  const [statusError, setStatusError] = useState<string | null>(null)

  const [doctor, setDoctor] = useState<DoctorCheck[] | null>(null)
  const [doctorLoading, setDoctorLoading] = useState(false)

  const [migrations, setMigrations] = useState<MigrationPlan | null>(null)
  const [migrationsLoading, setMigrationsLoading] = useState(true)
  const [migrationsError, setMigrationsError] = useState<string | null>(null)
  const [applying, setApplying] = useState(false)

  const [backupOpts, setBackupOpts] = useState<BackupOptions>({
    secrets: false,
    workspace: false,
    live: false,
  })
  const [creatingBackup, setCreatingBackup] = useState(false)
  const [deletingName, setDeletingName] = useState<string | null>(null)

  const [restoreArchive, setRestoreArchive] = useState('')
  const [restoreFile, setRestoreFile] = useState<File | null>(null)
  const [validation, setValidation] = useState<RestoreValidation | null>(null)
  const [validating, setValidating] = useState(false)
  const [restoreError, setRestoreError] = useState<string | null>(null)
  const [scheduling, setScheduling] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [auditEntries, setAuditEntries] = useState<MaintenanceAuditEntry[] | null>(null)
  const [auditLoading, setAuditLoading] = useState(true)
  const [auditError, setAuditError] = useState<string | null>(null)
  const [clearingAudit, setClearingAudit] = useState(false)

  const loadStatus = useCallback(async () => {
    setStatusLoading(true)
    setStatusError(null)
    try {
      setStatus(await synthApi.getStatus())
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : t('maintenance.loadError'))
    } finally {
      setStatusLoading(false)
    }
  }, [t])

  const loadMigrations = useCallback(async () => {
    setMigrationsLoading(true)
    setMigrationsError(null)
    try {
      setMigrations(await synthApi.getMigrations())
    } catch (err) {
      setMigrationsError(err instanceof Error ? err.message : t('maintenance.schema.loadError'))
    } finally {
      setMigrationsLoading(false)
    }
  }, [t])

  const loadAudit = useCallback(async () => {
    setAuditLoading(true)
    setAuditError(null)
    try {
      const { entries } = await synthApi.listAudit()
      setAuditEntries(entries)
    } catch (err) {
      setAuditEntries(null)
      setAuditError(err instanceof Error ? err.message : t('maintenance.audit.loadError'))
    } finally {
      setAuditLoading(false)
    }
  }, [t])

  useEffect(() => {
    void loadStatus()
  }, [loadStatus])

  useEffect(() => {
    void loadMigrations()
  }, [loadMigrations])

  useEffect(() => {
    void loadAudit()
  }, [loadAudit])

  /** «Проверить»: перезапускает `synth doctor` и перечитывает статус (сводка проверок). */
  const handleCheck = useCallback(async () => {
    setDoctorLoading(true)
    try {
      const result = await synthApi.getDoctor()
      setDoctor(result.checks)
    } catch (err) {
      notify({
        text: t('maintenance.status.checkError', {
          error: err instanceof Error ? err.message : t('common.error'),
        }),
        type: 'error',
        category: 'error',
      })
    } finally {
      setDoctorLoading(false)
      void loadStatus()
    }
  }, [t, notify, loadStatus])

  const handleApply = useCallback(async () => {
    const ok = await confirm({
      title: t('maintenance.schema.applyTitle'),
      message: t('maintenance.schema.applyConfirm'),
      confirmLabel: t('maintenance.schema.apply'),
      variant: 'danger',
      icon: 'database-2',
    })
    if (!ok) return
    setApplying(true)
    setMigrationsError(null)
    try {
      const result = await synthApi.applyMigrations()
      notify({
        text: t('maintenance.schema.applySuccess', { count: result.applied.length }),
        type: 'success',
        category: 'system',
      })
      await Promise.all([loadStatus(), loadMigrations()])
    } catch (err) {
      const message = err instanceof Error ? err.message : t('common.error')
      setMigrationsError(message)
      notify({
        text: t('maintenance.schema.applyError', { error: message }),
        type: 'error',
        category: 'error',
      })
    } finally {
      setApplying(false)
    }
  }, [t, notify, loadStatus, loadMigrations])

  const handleCreateBackup = useCallback(async () => {
    setCreatingBackup(true)
    try {
      const info = await synthApi.createBackup({
        withSecrets: backupOpts.secrets,
        withWorkspace: backupOpts.workspace,
        live: backupOpts.live,
      })
      notify({
        text: t('maintenance.backups.createSuccess', { name: info.name }),
        type: 'success',
        category: 'system',
      })
      await loadStatus()
    } catch (err) {
      notify({
        text: t('maintenance.backups.createError', {
          error: err instanceof Error ? err.message : t('common.error'),
        }),
        type: 'error',
        category: 'error',
      })
    } finally {
      setCreatingBackup(false)
    }
  }, [t, notify, loadStatus, backupOpts])

  const handleDownload = useCallback((name: string) => {
    const url = synthApi.backupDownloadUrl(name)
    const a = document.createElement('a')
    a.href = url
    a.download = name
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }, [])

  const handleDelete = useCallback(
    async (backup: MaintenanceBackupInfo) => {
      const ok = await confirm({
        title: t('maintenance.backups.deleteTitle'),
        message: t('maintenance.backups.deleteConfirm', { name: backup.name }),
        confirmLabel: t('common.delete'),
        variant: 'danger',
        icon: 'delete-bin',
      })
      if (!ok) return
      setDeletingName(backup.name)
      try {
        await synthApi.deleteBackup(backup.name)
        if (restoreArchive === backup.name) {
          setRestoreArchive('')
          setValidation(null)
        }
        notify({ text: t('maintenance.backups.deleted'), type: 'success', category: 'system' })
        await loadStatus()
      } catch (err) {
        notify({
          text: t('maintenance.backups.deleteError', {
            error: err instanceof Error ? err.message : t('common.error'),
          }),
          type: 'error',
          category: 'error',
        })
      } finally {
        setDeletingName(null)
      }
    },
    [t, notify, loadStatus, restoreArchive],
  )

  /** Имя архива для проверки/восстановления: загруженный (`staged`) приоритетнее выбранного. */
  const effectiveArchive = validation?.staged ?? restoreArchive

  const handleValidate = useCallback(async () => {
    if (!restoreFile && !restoreArchive) {
      setRestoreError(t('maintenance.restore.needArchive'))
      return
    }
    setValidating(true)
    setRestoreError(null)
    try {
      const result = restoreFile
        ? await synthApi.validateRestoreUpload(restoreFile)
        : await synthApi.validateRestoreByRef(restoreArchive)
      setValidation(result)
    } catch (err) {
      const message = err instanceof Error ? err.message : t('common.error')
      setRestoreError(message)
      notify({
        text: t('maintenance.restore.validateError', { error: message }),
        type: 'error',
        category: 'error',
      })
    } finally {
      setValidating(false)
    }
  }, [t, notify, restoreFile, restoreArchive])

  const handleSchedule = useCallback(async () => {
    if (!effectiveArchive) {
      setRestoreError(t('maintenance.restore.needArchive'))
      return
    }
    const ok = await confirm({
      title: t('maintenance.restore.scheduleTitle'),
      message: t('maintenance.restore.scheduleConfirm', { archive: effectiveArchive }),
      confirmLabel: t('maintenance.restore.schedule'),
      variant: 'danger',
      icon: 'database-2',
    })
    if (!ok) return
    setScheduling(true)
    setRestoreError(null)
    try {
      await synthApi.scheduleRestore(effectiveArchive, true)
      notify({ text: t('maintenance.restore.scheduleSuccess'), type: 'success', category: 'system' })
      setValidation(null)
      setRestoreFile(null)
      setRestoreArchive('')
      if (fileInputRef.current) fileInputRef.current.value = ''
      await loadStatus()
    } catch (err) {
      const message = err instanceof Error ? err.message : t('common.error')
      setRestoreError(message)
      notify({
        text: t('maintenance.restore.scheduleError', { error: message }),
        type: 'error',
        category: 'error',
      })
    } finally {
      setScheduling(false)
    }
  }, [t, notify, effectiveArchive, loadStatus])

  const handleCancelRestore = useCallback(async () => {
    setScheduling(true)
    try {
      await synthApi.cancelRestore()
      notify({ text: t('maintenance.restore.cancelled'), type: 'success', category: 'system' })
      await loadStatus()
    } catch (err) {
      notify({
        text: t('maintenance.restore.cancelError', {
          error: err instanceof Error ? err.message : t('common.error'),
        }),
        type: 'error',
        category: 'error',
      })
    } finally {
      setScheduling(false)
    }
  }, [t, notify, loadStatus])

  const handleClearAudit = useCallback(async () => {
    const ok = await confirm({
      title: t('maintenance.audit.clearTitle'),
      message: t('maintenance.audit.clearConfirm'),
      confirmLabel: t('maintenance.audit.clear'),
      variant: 'danger',
      icon: 'delete-bin',
    })
    if (!ok) return
    setClearingAudit(true)
    try {
      const { cleared } = await synthApi.clearAudit()
      notify({
        text: t('maintenance.audit.cleared', { count: cleared }),
        type: 'success',
        category: 'system',
      })
      await loadAudit()
    } catch (err) {
      notify({
        text: t('maintenance.audit.clearError', {
          error: err instanceof Error ? err.message : t('common.error'),
        }),
        type: 'error',
        category: 'error',
      })
    } finally {
      setClearingAudit(false)
    }
  }, [t, notify, loadAudit])

  const backups = status?.backups ?? []
  // ADR-091: зашифрованные архивы восстанавливаются только через CLI (ключ
  // серверу недоступен) — из выбора восстановления исключаются.
  const restorableBackups = backups.filter((backup) => !backup.encrypted)
  const pendingRestore = status?.pendingRestore ?? null

  /** Строка-чекбокс опций снятия архива. */
  const optionRow = (key: keyof BackupOptions, label: string, hint: string) => (
    <label
      key={key}
      className="flex items-start gap-2 min-w-0 cursor-pointer"
      data-testid={`maintenance-backup-opt-${key}`}
    >
      <input
        type="checkbox"
        className="mt-0.5 size-4 shrink-0 accent-primary"
        checked={backupOpts[key]}
        onChange={(e) => setBackupOpts((prev) => ({ ...prev, [key]: e.target.checked }))}
      />
      <span className="min-w-0">
        <span className="block text-sm font-medium text-foreground break-words">{label}</span>
        <span className="block text-xs text-muted-foreground break-words">{hint}</span>
      </span>
    </label>
  )

  return (
    <SettingsPanel title={t('maintenance.title')} description={t('maintenance.description')}>
      {/* 1. Состояние инстанса */}
      <SettingsSection
        title={t('maintenance.status.title')}
        description={t('maintenance.status.description')}
        actions={
          <Button
            variant="outline"
            className="min-h-10 shrink-0"
            onClick={() => void handleCheck()}
            disabled={doctorLoading}
            data-testid="maintenance-check"
          >
            <Icon name="refresh" className={cn('size-3.5', doctorLoading && 'animate-spin')} />
            {doctorLoading ? t('maintenance.status.checking') : t('maintenance.status.check')}
          </Button>
        }
      >
        {statusError && (
          <div role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
            {statusError}
          </div>
        )}

        {statusLoading && !status && (
          <div className="py-3 text-center text-xs text-muted-foreground">{t('common.loading')}</div>
        )}

        {status && (
          <>
            <div className="space-y-1.5" data-testid="maintenance-status-summary">
              <InfoField label={t('maintenance.status.version')} value={status.version} mono />
              <InfoField label={t('maintenance.status.dataDir')} value={status.dataDir} mono />
              <InfoField
                label={t('maintenance.status.schema')}
                value={t('maintenance.status.schemaValue', {
                  current: status.schema.current,
                  expected: status.schema.expected,
                })}
                mono
              />
            </div>

            <div
              className={cn(
                'flex flex-wrap items-baseline gap-x-2 text-sm font-medium',
                status.doctor.ok ? 'text-status-success' : 'text-destructive',
              )}
              data-testid="maintenance-doctor-summary"
            >
              {status.doctor.ok
                ? t('maintenance.status.healthOk')
                : t('maintenance.status.healthFail')}
              <span className="text-xs font-normal text-muted-foreground">
                {t('maintenance.status.doctorSummary', {
                  warn: status.doctor.warn,
                  fail: status.doctor.fail,
                })}
              </span>
            </div>

            <div className="space-y-1.5 min-w-0">
              <div className="text-xs text-muted-foreground">{t('maintenance.status.checks')}</div>
              {doctor && doctor.length > 0 ? (
                <ul className="space-y-1.5 min-w-0" data-testid="maintenance-doctor-checks">
                  {doctor.map((check) => (
                    <li
                      key={check.id}
                      className="min-w-0"
                      data-testid={`maintenance-check-${check.id}`}
                    >
                      <div className="flex items-start gap-2 min-w-0">
                        <span
                          className={cn('shrink-0 font-mono text-sm', DOCTOR_CLASS[check.status])}
                          aria-hidden
                        >
                          {DOCTOR_GLYPH[check.status]}
                        </span>
                        <div className="min-w-0">
                          <div className="text-sm text-foreground break-words">{check.title}</div>
                          {check.detail && (
                            <div className="text-xs text-muted-foreground break-words">
                              {check.detail}
                            </div>
                          )}
                          {check.hint && (
                            <div className="text-xs text-muted-foreground/80 break-words">
                              → {check.hint}
                            </div>
                          )}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-muted-foreground" data-testid="maintenance-doctor-empty">
                  {t('maintenance.status.checksEmpty')}
                </p>
              )}
            </div>
          </>
        )}
      </SettingsSection>

      {/* 2. Схема данных и миграции */}
      <SettingsSection
        title={t('maintenance.schema.title')}
        description={t('maintenance.schema.description')}
      >
        {migrationsError && (
          <div
            role="alert"
            data-testid="maintenance-migrations-error"
            className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive"
          >
            {migrationsError}
          </div>
        )}

        {migrationsLoading && !migrations && (
          <div className="py-3 text-center text-xs text-muted-foreground">{t('common.loading')}</div>
        )}

        {migrations && (
          <>
            <InfoField
              label={t('maintenance.status.schema')}
              value={t('maintenance.status.schemaValue', {
                current: migrations.current,
                expected: migrations.expected,
              })}
              mono
            />
            <InfoField
              label={t('maintenance.schema.applied')}
              value={
                migrations.applied.length > 0
                  ? migrations.applied.join(', ')
                  : t('maintenance.schema.noneApplied')
              }
              mono
            />

            {migrations.pending.length > 0 ? (
              <div className="space-y-2 min-w-0" data-testid="maintenance-migrations-pending">
                <div className="text-xs text-muted-foreground">
                  {t('maintenance.schema.pending')}
                </div>
                <ul className="space-y-1 min-w-0">
                  {migrations.pending.map((migration) => (
                    <li
                      key={migration.id}
                      className="flex flex-wrap items-baseline gap-1.5 min-w-0"
                      data-testid={`maintenance-migration-${migration.id}`}
                    >
                      <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[0.625rem]">
                        {t('maintenance.schema.version', { version: migration.toVersion })}
                      </span>
                      <span className="min-w-0 break-words text-xs">{migration.id}</span>
                      {migration.description && (
                        <span className="min-w-0 break-words text-xs text-muted-foreground">
                          — {migration.description}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
                <Button
                  variant="outline-primary"
                  onClick={() => void handleApply()}
                  disabled={applying}
                  data-testid="maintenance-migrations-apply"
                >
                  <Icon name="database-2" className="size-3.5" />
                  {applying ? t('maintenance.schema.applying') : t('maintenance.schema.apply')}
                </Button>
              </div>
            ) : (
              <div
                className="text-xs text-muted-foreground"
                data-testid="maintenance-migrations-none"
              >
                {t('maintenance.schema.nonePending')}
              </div>
            )}
          </>
        )}
      </SettingsSection>

      {/* 3. Бэкапы */}
      <SettingsSection
        title={t('maintenance.backups.title')}
        description={t('maintenance.backups.description', { dataDir: status?.dataDir ?? '' })}
      >
        <div className="space-y-2 min-w-0" data-testid="maintenance-backup-options">
          {optionRow(
            'secrets',
            t('maintenance.backups.optSecrets'),
            t('maintenance.backups.optSecretsHint'),
          )}
          {optionRow(
            'workspace',
            t('maintenance.backups.optWorkspace'),
            t('maintenance.backups.optWorkspaceHint'),
          )}
          {optionRow('live', t('maintenance.backups.optLive'), t('maintenance.backups.optLiveHint'))}
        </div>

        <Button
          variant="primary"
          onClick={() => void handleCreateBackup()}
          disabled={creatingBackup}
          data-testid="maintenance-backup-create"
        >
          <Icon name="save" className="size-3.5" />
          {creatingBackup ? t('maintenance.backups.creating') : t('maintenance.backups.create')}
        </Button>

        <div className="text-xs text-muted-foreground" data-testid="maintenance-backups-count">
          {t('maintenance.backups.count', { count: backups.length })}
        </div>

        {statusLoading && !status ? (
          <div className="py-3 text-center text-xs text-muted-foreground">{t('common.loading')}</div>
        ) : backups.length === 0 ? (
          <div
            className="flex flex-col items-center gap-1 py-4 text-center text-muted-foreground"
            data-testid="maintenance-backups-empty"
          >
            <Icon name="database-2" className="size-6 opacity-40" />
            <p className="text-xs">{t('maintenance.backups.empty')}</p>
          </div>
        ) : (
          <ul className="space-y-2 min-w-0" data-testid="maintenance-backups-list">
            {backups.map((backup) => (
              <li
                key={backup.name}
                data-testid={`maintenance-backup-${backup.name}`}
                className="space-y-1.5 rounded-lg border border-border/60 bg-surface-inset p-2.5 min-w-0"
              >
                <div className="flex flex-wrap items-start justify-between gap-2 min-w-0">
                  <span className="min-w-0 break-all font-mono text-xs text-foreground">
                    {backup.name}
                  </span>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="min-h-10 min-w-10"
                      onClick={() => handleDownload(backup.name)}
                      disabled={!!backup.encrypted}
                      title={
                        backup.encrypted
                          ? t('maintenance.backups.encryptedCli')
                          : t('maintenance.backups.download')
                      }
                      aria-label={
                        backup.encrypted
                          ? t('maintenance.backups.encryptedCli')
                          : t('maintenance.backups.download')
                      }
                      data-testid={`maintenance-backup-download-${backup.name}`}
                    >
                      <Icon name="download" className="size-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="min-h-10 min-w-10 hover:text-destructive"
                      onClick={() => void handleDelete(backup)}
                      disabled={deletingName === backup.name}
                      title={t('maintenance.backups.delete')}
                      aria-label={t('maintenance.backups.delete')}
                      data-testid={`maintenance-backup-delete-${backup.name}`}
                    >
                      <Icon name="delete-bin" className="size-4" />
                    </Button>
                  </div>
                </div>

                {(backup.encrypted || backup.withSecrets || backup.withWorkspace) && (
                  <div className="flex flex-wrap gap-1 min-w-0">
                    {backup.encrypted && (
                      <span
                        className="shrink-0 rounded bg-primary/15 px-1.5 py-0.5 text-[0.625rem] font-medium text-primary"
                        data-testid={`maintenance-backup-encrypted-${backup.name}`}
                      >
                        {t('maintenance.backups.badgeEncrypted')}
                      </span>
                    )}
                    {backup.withSecrets && (
                      <span className="shrink-0 rounded bg-status-warning/15 px-1.5 py-0.5 text-[0.625rem] font-medium text-status-warning">
                        {t('maintenance.backups.badgeSecrets')}
                      </span>
                    )}
                    {backup.withWorkspace && (
                      <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[0.625rem] font-medium text-muted-foreground">
                        {t('maintenance.backups.badgeWorkspace')}
                      </span>
                    )}
                  </div>
                )}

                <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[0.6875rem] text-muted-foreground min-w-0">
                  <span className="min-w-0 break-words">
                    {t('maintenance.backups.metaCreated')}:{' '}
                    {formatDateTime(backup.createdAt, locale)}
                  </span>
                  <span className="min-w-0 break-words">
                    {t('maintenance.backups.metaSize')}: {formatBytes(backup.bytes)}
                  </span>
                  {backup.metadataAvailable !== false && (
                    <>
                      <span className="min-w-0 break-words">
                        {t('maintenance.backups.metaSchema')}: {backup.schemaVersion}
                      </span>
                      <span className="min-w-0 break-words">
                        {t('maintenance.backups.metaInstance')}: {backup.instanceVersion}
                      </span>
                      <span className="min-w-0 break-words">
                        {t('maintenance.backups.metaEntries')}: {backup.entries}
                      </span>
                    </>
                  )}
                  {backup.metadataAvailable === false && (
                    <span
                      className="min-w-0 break-words text-status-warning"
                      data-testid={`maintenance-backup-meta-unavailable-${backup.name}`}
                    >
                      {t('maintenance.backups.metaUnavailable')}
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </SettingsSection>

      {/* 4. Восстановление */}
      <SettingsSection
        title={t('maintenance.restore.title')}
        description={t('maintenance.restore.description')}
      >
        <div
          role="alert"
          data-testid="maintenance-restore-warning"
          className="rounded-lg bg-status-warning/10 p-3 text-sm text-status-warning"
        >
          {t('maintenance.restore.warning')}
        </div>

        {pendingRestore && (
          <div
            className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-status-warning/40 bg-status-warning/10 p-3 min-w-0"
            data-testid="maintenance-restore-pending"
          >
            <span className="min-w-0 break-words text-sm">
              {t('maintenance.restore.pending', {
                archive: archiveBaseName(pendingRestore.archive),
                date: formatDateTime(pendingRestore.requestedAt, locale),
              })}
            </span>
            <Button
              variant="outline-muted"
              className="shrink-0"
              onClick={() => void handleCancelRestore()}
              disabled={scheduling}
              data-testid="maintenance-restore-cancel"
            >
              {t('maintenance.restore.cancel')}
            </Button>
          </div>
        )}

        <SelectField
          label={t('maintenance.restore.selectLabel')}
          value={restoreArchive}
          onValueChange={(value) => {
            setRestoreArchive(value)
            setValidation(null)
            setRestoreError(null)
          }}
          triggerTestId="maintenance-restore-select"
          items={restorableBackups.map((backup) => ({ label: backup.name, value: backup.name }))}
        >
          <SelectContent>
            <SelectItem value="">{t('maintenance.restore.selectPlaceholder')}</SelectItem>
            {restorableBackups.map((backup) => (
              <SelectItem key={backup.name} value={backup.name}>
                {backup.name}
              </SelectItem>
            ))}
          </SelectContent>
        </SelectField>

        <div className="space-y-1 min-w-0">
          <label
            className="text-sm font-medium text-foreground"
            htmlFor="maintenance-restore-file"
          >
            {t('maintenance.restore.uploadLabel')}
          </label>
          <input
            ref={fileInputRef}
            id="maintenance-restore-file"
            type="file"
            accept=".tar.gz,.tgz,application/gzip"
            className="block w-full min-w-0 text-xs text-muted-foreground file:mr-2 file:rounded-lg file:border file:border-border file:bg-transparent file:px-3 file:py-1.5 file:text-xs file:text-foreground"
            data-testid="maintenance-restore-file"
            onChange={(e) => {
              setRestoreFile(e.target.files?.[0] ?? null)
              setValidation(null)
              setRestoreError(null)
            }}
          />
        </div>

        {restoreError && (
          <div
            role="alert"
            data-testid="maintenance-restore-error"
            className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive"
          >
            {restoreError}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            onClick={() => void handleValidate()}
            disabled={validating}
            data-testid="maintenance-restore-validate"
          >
            <Icon name="check" className="size-3.5" />
            {validating ? t('maintenance.restore.validating') : t('maintenance.restore.validate')}
          </Button>
          {validation?.ok && (
            <Button
              variant="danger"
              onClick={() => void handleSchedule()}
              disabled={scheduling}
              data-testid="maintenance-restore-schedule"
            >
              <Icon name="database-2" className="size-3.5" />
              {t('maintenance.restore.schedule')}
            </Button>
          )}
        </div>

        {validation && (
          <div
            className="space-y-2 rounded-lg border border-border/60 bg-surface-inset p-3 min-w-0"
            data-testid="maintenance-restore-validation"
          >
            {validation.ok ? (
              <>
                <p className="text-sm text-status-success" data-testid="maintenance-restore-valid">
                  {t('maintenance.restore.validOk')}
                </p>
                {validation.manifest && (
                  <div className="space-y-1.5 min-w-0" data-testid="maintenance-restore-manifest">
                    <div className="text-xs text-muted-foreground">
                      {t('maintenance.restore.manifestTitle')}
                    </div>
                    <InfoField
                      label={t('maintenance.restore.manifestSchema')}
                      value={String(validation.manifest.schemaVersion)}
                      mono
                    />
                    <InfoField
                      label={t('maintenance.restore.manifestInstance')}
                      value={validation.manifest.instanceVersion}
                      mono
                    />
                    <InfoField
                      label={t('maintenance.restore.manifestEntries')}
                      value={String(validation.manifest.entries)}
                      mono
                    />
                    <InfoField
                      label={t('maintenance.restore.manifestSecrets')}
                      value={
                        validation.manifest.withSecrets
                          ? t('maintenance.restore.yes')
                          : t('maintenance.restore.no')
                      }
                    />
                    <InfoField
                      label={t('maintenance.restore.manifestWorkspace')}
                      value={
                        validation.manifest.withWorkspace
                          ? t('maintenance.restore.yes')
                          : t('maintenance.restore.no')
                      }
                    />
                    <InfoField
                      label={t('maintenance.restore.manifestCreated')}
                      value={formatDateTime(validation.manifest.createdAt, locale)}
                    />
                  </div>
                )}
              </>
            ) : (
              <p
                className="text-sm text-destructive"
                data-testid="maintenance-restore-problem"
              >
                {t('maintenance.restore.validFail', { problem: validation.problem ?? '' })}
              </p>
            )}
          </div>
        )}
      </SettingsSection>

      {/* 5. Журнал обслуживания (ADR-092) */}
      <SettingsSection
        title={t('maintenance.audit.title')}
        description={t('maintenance.audit.description')}
      >
        {auditError && (
          <div
            role="alert"
            data-testid="maintenance-audit-error"
            className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive"
          >
            {auditError}
          </div>
        )}

        {auditLoading && auditEntries === null && (
          <div className="py-3 text-center text-xs text-muted-foreground">{t('common.loading')}</div>
        )}

        {auditEntries !== null && (
          <>
            <div className="text-xs text-muted-foreground" data-testid="maintenance-audit-count">
              {t('maintenance.audit.count', { count: auditEntries.length })}
            </div>

            {auditEntries.length === 0 ? (
              <div
                className="flex flex-col items-center gap-1 py-4 text-center text-muted-foreground"
                data-testid="maintenance-audit-empty"
              >
                <Icon name="file-list" className="size-6 opacity-40" />
                <p className="text-xs">{t('maintenance.audit.empty')}</p>
              </div>
            ) : (
              <ul className="space-y-2 min-w-0" data-testid="maintenance-audit-list">
                {auditEntries.map((entry) => (
                  <li
                    key={entry.id}
                    data-testid={`maintenance-audit-${entry.id}`}
                    className="space-y-1 rounded-lg border border-border/60 bg-surface-inset p-2.5 min-w-0"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2 min-w-0">
                      <span className="min-w-0 break-all font-mono text-xs text-foreground">
                        {entry.op}
                      </span>
                      <span
                        className={cn(
                          'shrink-0 rounded px-1.5 py-0.5 text-[0.625rem] font-medium',
                          AUDIT_STATUS_CLASS[entry.status],
                        )}
                        data-testid={`maintenance-audit-status-${entry.id}`}
                      >
                        {t(`maintenance.audit.status.${entry.status}`)}
                      </span>
                    </div>

                    <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[0.6875rem] text-muted-foreground min-w-0">
                      <span className="min-w-0 break-words">
                        {t('maintenance.audit.colTime')}: {formatDateTime(entry.ts, locale)}
                      </span>
                      <span className="min-w-0 break-words">
                        {t('maintenance.audit.colActor')}:{' '}
                        {entry.actor ?? t('maintenance.audit.actorUnknown')}
                      </span>
                    </div>

                    {entry.error && (
                      <div className="min-w-0 break-words text-[0.6875rem] text-destructive">
                        {entry.error}
                      </div>
                    )}

                    {entry.details && (
                      <div
                        className="min-w-0 break-words font-mono text-[0.6875rem] text-muted-foreground"
                        data-testid={`maintenance-audit-details-${entry.id}`}
                      >
                        {summarizeAuditDetails(entry.details)}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            onClick={() => void loadAudit()}
            disabled={auditLoading}
            data-testid="maintenance-audit-refresh"
          >
            <Icon name="refresh" className={cn('size-3.5', auditLoading && 'animate-spin')} />
            {auditLoading ? t('maintenance.audit.refreshing') : t('maintenance.audit.refresh')}
          </Button>
          <Button
            variant="outline-muted"
            onClick={() => void handleClearAudit()}
            disabled={clearingAudit || (auditEntries?.length ?? 0) === 0}
            data-testid="maintenance-audit-clear"
          >
            <Icon name="delete-bin" className="size-3.5" />
            {t('maintenance.audit.clear')}
          </Button>
        </div>
      </SettingsSection>
    </SettingsPanel>
  )
}
