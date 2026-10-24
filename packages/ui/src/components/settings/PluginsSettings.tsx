import { useCallback, useEffect, useMemo, useState } from 'react'

import { useI18n } from '@/lib/i18n'
import { useNotification } from '@/hooks/useNotification'
import { confirm } from '@/lib/confirm'
import { cn } from '@/lib/utils'
import { formatDateTime } from '@/lib/formatDate'
import { useAuthStore } from '@/stores/authStore'
import { Button } from '../ui/button'
import { Icon } from '../icon/Icon'
import { SelectContent, SelectItem } from '../ui/select'
import {
  InfoField,
  NumberField,
  SelectField,
  SettingsActions,
  SettingsPanel,
  SettingsSection,
  TextField,
  ToggleField,
  useSettingsDraft,
} from '../ui/settings'
import {
  synthApi,
  type PluginAuditEntry,
  type PluginInstallInput,
  type PluginInstallSourceKind,
  type PluginRuntimeEntry,
  type PluginScanVerdict,
  type PluginServerPolicyStatus,
  type PluginsPolicyValues,
  type PluginsSettingsInfo,
  type PluginTrustLevel,
} from '@/lib/api/synthApi'

/**
 * ADR-090, Ф6: админ-раздел «Плагины» — установленные плагины слоя
 * расширений, их жизненный цикл (включить/выключить, подтверждение карантина,
 * удаление, обновление, откат), установка из источника и runtime-политика слоя.
 *
 * Правда чтения и записи — на сервере: в managed (`backend`) чтение и настройки —
 * ADMIN, install/enable/disable — ADMIN или service-key со scope `addons:install`,
 * approve и DELETE — только ADMIN. UI лишь прячет недоступные действия
 * (`canManage` по роли), 403 читается понятной ошибкой.
 *
 * Важные состояния контракта:
 * - `202` от `POST /plugins/install` — не ошибка: бандл ушёл в карантин и ждёт
 *   подтверждения (`approve`); такие установки показываются отдельными карточками.
 * - `403 plugin.managed_readonly` — плагин поставлен развёртыванием
 *   (`source === 'deploy'`): снимать и переустанавливать его нельзя, в карточке
 *   показывается признак «управляемый», кнопки снятия/обновления скрыты.
 * - `/settings/plugins` всегда возвращает `restartRequired: true` (инвариант 24):
 *   рантайм плагинов собирается при старте, изменения применяются рестартом.
 */

/** Уровни доверия, доступные при установке из UI (`builtin` выдаёт только образ). */
const INSTALL_TRUST_LEVELS: PluginTrustLevel[] = ['trusted', 'verified', 'community']

/** Уровни порога доверия инстанса (`plugins.trustFloor`). */
const TRUST_FLOOR_LEVELS: PluginTrustLevel[] = ['builtin', 'verified', 'trusted', 'community']

/** Цвет бейджа доверия. */
const TRUST_BADGE_CLASS: Record<PluginTrustLevel, string> = {
  builtin: 'bg-primary/15 text-primary',
  verified: 'bg-status-success/15 text-status-success',
  trusted: 'bg-status-success/15 text-status-success',
  community: 'bg-muted text-muted-foreground',
}

/** Цвет бейджа вердикта сканера. */
const VERDICT_BADGE_CLASS: Record<PluginScanVerdict, string> = {
  safe: 'bg-status-success/15 text-status-success',
  caution: 'bg-status-warning/15 text-status-warning',
  dangerous: 'bg-destructive/15 text-destructive',
}

/**
 * Цвет бейджа серверной политики в гибридном режиме (ADR-090 Ф7).
 *
 * `allowed` — сервер подтвердил (тот же зелёный, что у активного плагина);
 * `denied` — сервер запретил (красный — как у опасного вердикта скана);
 * `unverified` — сервер не подтвердил (предупреждение: политика неизвестна).
 */
const SERVER_POLICY_BADGE_CLASS: Record<PluginServerPolicyStatus, string> = {
  allowed: 'bg-status-success/15 text-status-success',
  denied: 'bg-destructive/15 text-destructive',
  unverified: 'bg-status-warning/15 text-status-warning',
}

/** Общий стиль бейджа (как в соседних админ-разделах). */
const BADGE = 'shrink-0 rounded px-1.5 py-0.5 text-[0.625rem] font-medium'
/** Короткий вид content-hash: 12 символов достаточно для сверки глазами. */
export function shortHash(hash: string): string {
  return hash.length > 12 ? `${hash.slice(0, 12)}…` : hash
}

/**
 * Цвет бейджа итога операции журнала плагинов.
 *
 * `ok` — состояние достигнуто (установка/активация прошли); `rejected` —
 * отказ по гейту (тогда в записи есть код причины).
 */
const AUDIT_OUTCOME_BADGE_CLASS: Record<'ok' | 'rejected', string> = {
  ok: 'bg-status-success/15 text-status-success',
  rejected: 'bg-destructive/15 text-destructive',
}

/**
 * Вид источника установки по строке ввода (тот же вывод, что у сервера):
 * `https://…` → `url`; `.tgz`/`.tar.gz` → `archive`; npm-имя → `npm`; иначе `dir`.
 */
export function inferInstallSource(ref: string): PluginInstallSourceKind {
  const value = ref.trim()
  if (/^https:\/\//i.test(value)) return 'url'
  if (/\.(tgz|tar\.gz)$/i.test(value)) return 'archive'
  if (/^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(value)) return 'npm'
  return 'dir'
}

/** Тело `POST /plugins/install` из полей формы (вид источника выводится по ссылке). */
export function buildInstallInput(
  ref: string,
  trustLevel: PluginTrustLevel,
  sha256 = '',
): PluginInstallInput {
  const value = ref.trim()
  const kind = inferInstallSource(value)
  const pin = sha256.trim().toLowerCase()
  return {
    source: kind,
    ...(kind === 'url'
      ? { url: value, ...(pin ? { sha256: pin } : {}) }
      : kind === 'npm'
        ? { name: value }
        : { path: value }),
    trustLevel,
  }
}

/** Статус HTTP-ошибки (403 — нет прав/политика инстанса). */
const statusOf = (err: unknown): number | undefined =>
  typeof (err as { status?: unknown })?.status === 'number'
    ? (err as { status: number }).status
    : undefined

/** Машиночитаемый код ошибки API (`plugin.managed_readonly`, `LOCAL_INSTALL_DISABLED`, …). */
const codeOf = (err: unknown): string | undefined =>
  typeof (err as { code?: unknown })?.code === 'string'
    ? (err as { code: string }).code
    : undefined

/** Установка ждёт подтверждения (бандл в карантине, `202`). */
interface PendingInstall {
  name: string
  version: string
}

export function PluginsSettings() {
  const { t, locale } = useI18n()
  const { notify } = useNotification()
  const userRoles = useAuthStore((s) => s.user?.roles) ?? []
  const canManage = userRoles.includes('ADMIN')

  const [plugins, setPlugins] = useState<PluginRuntimeEntry[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  /** Установки, ожидающие подтверждения карантина (локальное состояние: `202`). */
  const [pending, setPending] = useState<PendingInstall[]>([])
  /** Известные ступени отката (из ответов `update`): имя → прежняя версия. */
  const [previousVersions, setPreviousVersions] = useState<Record<string, string>>({})

  /** Журнал действий плагинов (ADR-090): хвост, «свежие первыми». */
  const [audit, setAudit] = useState<PluginAuditEntry[] | null>(null)
  const [auditLoading, setAuditLoading] = useState(true)
  const [auditError, setAuditError] = useState<string | null>(null)

  const [installRef, setInstallRef] = useState('')
  const [installSha, setInstallSha] = useState('')
  const [installTrust, setInstallTrust] = useState<PluginTrustLevel>('community')
  const [installing, setInstalling] = useState(false)
  const [installError, setInstallError] = useState<string | null>(null)

  const [settings, setSettings] = useState<PluginsSettingsInfo | null>(null)
  const [settingsLoading, setSettingsLoading] = useState(true)
  const [settingsError, setSettingsError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [restarting, setRestarting] = useState(false)

  /** Понятная ошибка раздела: 403 — «нужны права администратора», иначе текст сервера. */
  const describeError = useCallback(
    (err: unknown, fallback: string): string => {
      const message = err instanceof Error ? err.message : fallback
      if (statusOf(err) === 403 && !codeOf(err)) return t('plugins.forbidden')
      return message
    },
    [t],
  )

  const loadPlugins = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      setPlugins(await synthApi.listPlugins())
    } catch (err) {
      setLoadError(describeError(err, t('plugins.loadError', { error: t('common.error') })))
    } finally {
      setLoading(false)
    }
  }, [describeError, t])

  const loadSettings = useCallback(async () => {
    setSettingsLoading(true)
    setSettingsError(null)
    try {
      setSettings(await synthApi.getPluginsSettings())
    } catch (err) {
      setSettingsError(
        describeError(err, t('plugins.settings.loadError', { error: t('common.error') })),
      )
    } finally {
      setSettingsLoading(false)
    }
  }, [describeError, t])

  /**
   * Журнал действий плагинов (ADR-090): последние записи — «свежие первыми».
   *
   * Чтение журнала не меняет состояние плагинов, поэтому блок обновляется
   * кнопкой «Обновить», а не по событиям.
   */
  const loadAudit = useCallback(async () => {
    setAuditLoading(true)
    setAuditError(null)
    try {
      setAudit(await synthApi.listPluginAudit())
    } catch (err) {
      setAuditError(describeError(err, t('plugins.audit.loadError', { error: t('common.error') })))
    } finally {
      setAuditLoading(false)
    }
  }, [describeError, t])

  useEffect(() => {
    void loadPlugins()
  }, [loadPlugins])

  useEffect(() => {
    void loadSettings()
  }, [loadSettings])

  useEffect(() => {
    void loadAudit()
  }, [loadAudit])

  /** Эффективная политика: дефолты config.yaml поверх runtime-override. */
  const effectivePolicy = useMemo<PluginsPolicyValues | null>(
    () => (settings ? { ...settings.defaults, ...settings.plugins } : null),
    [settings],
  )

  const draft = useSettingsDraft<PluginsPolicyValues>({
    value: effectivePolicy,
    defaultValue: settings?.defaults ?? null,
  })

  /** Включить/выключить плагин: активация или обратная прокрутка. */
  const handleToggleActive = useCallback(
    async (plugin: PluginRuntimeEntry) => {
      if (busy) return
      setBusy(plugin.name)
      try {
        if (plugin.active) await synthApi.disablePlugin(plugin.name)
        else await synthApi.enablePlugin(plugin.name)
        await loadPlugins()
        notify({
          text: plugin.active
            ? t('plugins.disabled', { name: plugin.name })
            : t('plugins.enabled', { name: plugin.name }),
          type: 'success',
          category: 'system',
        })
      } catch (err) {
        notify({
          text: t(plugin.active ? 'plugins.disableError' : 'plugins.enableError', {
            name: plugin.name,
            error: describeError(err, t('common.error')),
          }),
          type: 'error',
          category: 'error',
        })
      } finally {
        setBusy(null)
      }
    },
    [busy, describeError, loadPlugins, notify, t],
  )

  /** Подтверждение установки из карантина (только ADMIN, guard сервера). */
  const handleApprove = useCallback(
    async (item: PendingInstall) => {
      if (busy) return
      const ok = await confirm({
        title: t('plugins.approveConfirmTitle'),
        message: t('plugins.approveConfirm', { name: item.name }),
        confirmLabel: t('plugins.approve'),
        variant: 'warning',
        icon: 'shield-check',
      })
      if (!ok) return
      setBusy(item.name)
      try {
        await synthApi.approvePlugin(item.name)
        setPending((prev) => prev.filter((entry) => entry.name !== item.name))
        await loadPlugins()
        notify({
          text: t('plugins.approved', { name: item.name }),
          type: 'success',
          category: 'system',
        })
      } catch (err) {
        notify({
          text: t('plugins.approveError', {
            name: item.name,
            error: describeError(err, t('common.error')),
          }),
          type: 'error',
          category: 'error',
        })
      } finally {
        setBusy(null)
      }
    },
    [busy, describeError, loadPlugins, notify, t],
  )

  /** Снятие плагина — через `confirm()` (управляемый плагин снять нельзя). */
  const handleRemove = useCallback(
    async (plugin: PluginRuntimeEntry) => {
      if (busy) return
      const ok = await confirm({
        title: t('plugins.removeConfirmTitle'),
        message: t('plugins.removeConfirm', { name: plugin.name }),
        confirmLabel: t('plugins.remove'),
        variant: 'danger',
        icon: 'delete-bin',
      })
      if (!ok) return
      setBusy(plugin.name)
      try {
        await synthApi.removePlugin(plugin.name)
        await loadPlugins()
        notify({
          text: t('plugins.removed', { name: plugin.name }),
          type: 'success',
          category: 'system',
        })
      } catch (err) {
        notify({
          text: t('plugins.removeError', {
            name: plugin.name,
            error: describeError(err, t('common.error')),
          }),
          type: 'error',
          category: 'error',
        })
      } finally {
        setBusy(null)
      }
    },
    [busy, describeError, loadPlugins, notify, t],
  )

  /** Обновление из источника записи lock (источник клиентом не выбирается). */
  const handleUpdate = useCallback(
    async (plugin: PluginRuntimeEntry) => {
      if (busy) return
      setBusy(plugin.name)
      try {
        const result = await synthApi.updatePlugin({ name: plugin.name })
        if (result.outcome === 'updated') {
          setPreviousVersions((prev) => ({ ...prev, [plugin.name]: result.previousVersion }))
          notify({
            text: t('plugins.updated', {
              name: plugin.name,
              from: result.previousVersion,
              to: result.version,
            }),
            type: 'success',
            category: 'system',
          })
        } else {
          notify({
            text: t('plugins.upToDate', { name: plugin.name, version: result.version }),
            type: 'info',
            category: 'system',
          })
        }
        await loadPlugins()
      } catch (err) {
        notify({
          text: t('plugins.updateError', {
            name: plugin.name,
            error: describeError(err, t('common.error')),
          }),
          type: 'error',
          category: 'error',
        })
      } finally {
        setBusy(null)
      }
    },
    [busy, describeError, loadPlugins, notify, t],
  )

  /** Откат на предыдущую версию; нет ступени — сервер отвечает `409`. */
  const handleRollback = useCallback(
    async (plugin: PluginRuntimeEntry) => {
      if (busy) return
      const ok = await confirm({
        title: t('plugins.rollbackConfirmTitle'),
        message: t('plugins.rollbackConfirm', { name: plugin.name }),
        confirmLabel: t('plugins.rollback'),
        variant: 'warning',
        icon: 'arrow-go-back',
      })
      if (!ok) return
      setBusy(plugin.name)
      try {
        const result = await synthApi.rollbackPlugin(plugin.name)
        notify({
          text: t('plugins.rolledBack', {
            name: plugin.name,
            from: result.previousVersion,
            to: result.version,
          }),
          type: 'success',
          category: 'system',
        })
        await loadPlugins()
      } catch (err) {
        const message =
          codeOf(err) === 'plugin.rollback_unavailable'
            ? t('plugins.rollbackUnavailable', { name: plugin.name })
            : describeError(err, t('common.error'))
        notify({
          text: t('plugins.rollbackError', { name: plugin.name, error: message }),
          type: 'error',
          category: 'error',
        })
      } finally {
        setBusy(null)
      }
    },
    [busy, describeError, loadPlugins, notify, t],
  )

  /**
   * Установка из источника. `202` (`approval_required`) — бандл в карантине:
   * показываем карточку с кнопкой «Подтвердить», а не ошибку. Отказ
   * (`403 LOCAL_INSTALL_DISABLED`, trust-floor, скан) — текстом из ответа.
   */
  const handleInstall = useCallback(async () => {
    if (installing) return
    const ref = installRef.trim()
    if (!ref) {
      setInstallError(t('plugins.install.refRequired'))
      return
    }
    setInstalling(true)
    setInstallError(null)
    try {
      const result = await synthApi.installPlugin(
        buildInstallInput(ref, installTrust, installSha),
      )
      if (result.outcome === 'approval_required') {
        setPending((prev) => [
          ...prev.filter((entry) => entry.name !== result.name),
          { name: result.name, version: result.version },
        ])
        notify({
          text: t('plugins.install.approvalRequired', { name: result.name }),
          type: 'warning',
          category: 'system',
        })
      } else {
        setInstallRef('')
        setInstallSha('')
        await loadPlugins()
        notify({
          text: t('plugins.installed', { name: result.name, version: result.version }),
          type: 'success',
          category: 'system',
        })
      }
    } catch (err) {
      setInstallError(describeError(err, t('common.error')))
    } finally {
      setInstalling(false)
    }
  }, [describeError, installRef, installSha, installTrust, installing, loadPlugins, notify, t])

  /** Сохранение политики слоя (применяется после перезапуска инстанса). */
  const handleSavePolicy = useCallback(async () => {
    if (!draft.draft || saving) return
    setSaving(true)
    try {
      const info = await synthApi.updatePluginsSettings(draft.draft)
      setSettings(info)
      notify({ text: t('plugins.settings.saved'), type: 'success', category: 'system' })
    } catch (err) {
      notify({
        text: t('plugins.settings.saveError', {
          error: describeError(err, t('common.error')),
        }),
        type: 'error',
        category: 'error',
      })
    } finally {
      setSaving(false)
    }
  }, [describeError, draft, notify, saving, t])

  /** Сброс runtime-политики к дефолтам config.yaml. */
  const handleResetPolicy = useCallback(async () => {
    if (saving) return
    const ok = await confirm({
      title: t('plugins.settings.resetConfirmTitle'),
      message: t('plugins.settings.resetConfirm'),
      confirmLabel: t('plugins.settings.reset'),
      variant: 'warning',
      icon: 'refresh',
    })
    if (!ok) return
    setSaving(true)
    try {
      const info = await synthApi.resetPluginsSettings()
      setSettings(info)
      // После сброса черновик обязан показать дефолты, а не прежние правки.
      draft.setDraft({ ...info.defaults, ...info.plugins })
      notify({ text: t('plugins.settings.saved'), type: 'success', category: 'system' })
    } catch (err) {
      notify({
        text: t('plugins.settings.saveError', {
          error: describeError(err, t('common.error')),
        }),
        type: 'error',
        category: 'error',
      })
    } finally {
      setSaving(false)
    }
  }, [describeError, draft, notify, saving, t])

  /** Перезапуск инстанса (ADR-092): политика слоя применяется при старте. */
  const handleRestart = useCallback(async () => {
    if (restarting) return
    const ok = await confirm({
      title: t('plugins.restart.confirmTitle'),
      message: t('plugins.restart.confirm'),
      confirmLabel: t('plugins.restart.button'),
      variant: 'danger',
      icon: 'refresh',
    })
    if (!ok) return
    setRestarting(true)
    try {
      await synthApi.restartInstance()
      notify({ text: t('plugins.restart.started'), type: 'success', category: 'system' })
    } catch (err) {
      notify({
        text: t('plugins.restart.error', {
          error: describeError(err, t('common.error')),
        }),
        type: 'error',
        category: 'error',
      })
    } finally {
      setRestarting(false)
    }
  }, [describeError, notify, restarting, t])

  const restartRequired = settings?.restartRequired ?? false
  const policy = draft.draft

  return (
    <SettingsPanel
      title={t('plugins.title')}
      description={t('plugins.description')}
      meta={t('plugins.count', { count: plugins?.length ?? 0 })}
    >
      {/* 1. Установленные плагины: карточки, активация, снятие, обновление, откат. */}
      <SettingsSection
        id="plugins-list"
        title={t('plugins.list.title')}
        description={t('plugins.list.description')}
        tooltip={t('settings.help.plugins.section.plugins-list')}
      >
        {loadError && (
          <div
            role="alert"
            data-testid="plugins-error"
            className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive break-words"
          >
            {loadError}
          </div>
        )}

        {loading && !plugins && (
          <div className="py-3 text-center text-xs text-muted-foreground">{t('common.loading')}</div>
        )}

        {pending.length > 0 && (
          <ul className="space-y-2 min-w-0" data-testid="plugins-pending-list">
            {pending.map((item) => (
              <li
                key={item.name}
                data-testid={`plugins-pending-${item.name}`}
                className="space-y-2 rounded-lg border border-status-warning/40 bg-status-warning/10 p-2.5 min-w-0"
              >
                <div className="flex flex-wrap items-center gap-1.5 min-w-0">
                  <span className="text-sm font-medium text-foreground break-words min-w-0">
                    {item.name}
                  </span>
                  <span className={cn(BADGE, 'bg-muted text-muted-foreground font-mono')}>
                    {item.version}
                  </span>
                  <span className={cn(BADGE, 'bg-status-warning/15 text-status-warning')}>
                    {t('plugins.pendingBadge')}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground break-words">
                  {t('plugins.pendingHint')}
                </p>
                {canManage && (
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => void handleApprove(item)}
                    disabled={busy !== null}
                    data-testid={`plugins-approve-${item.name}`}
                  >
                    <Icon name="shield-check" className="size-3.5" />
                    {t('plugins.approve')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}

        {plugins && plugins.length === 0 && (
          <div
            className="flex flex-col items-center gap-1 py-4 text-center text-muted-foreground"
            data-testid="plugins-empty"
          >
            <Icon name="plug" className="size-6 opacity-40" />
            <p className="text-xs">{t('plugins.list.empty')}</p>
          </div>
        )}

        {plugins && plugins.length > 0 && (
          <ul className="space-y-2 min-w-0" data-testid="plugins-list">
            {plugins.map((plugin) => {
              const managed = plugin.source === 'deploy'
              const busyNow = busy === plugin.name
              const rollbackVersion = previousVersions[plugin.name]
              return (
                <li
                  key={plugin.name}
                  data-testid={`plugins-item-${plugin.name}`}
                  className="space-y-2 rounded-lg border border-border/60 bg-surface-inset p-2.5 min-w-0"
                >
                  <div className="flex flex-wrap items-center gap-1.5 min-w-0">
                    <span className="text-sm font-medium text-foreground break-words min-w-0">
                      {plugin.name}
                    </span>
                    <span className={cn(BADGE, 'bg-muted text-muted-foreground font-mono')}>
                      {plugin.version}
                    </span>
                    {plugin.mode && (
                      <span
                        data-testid={`plugins-mode-${plugin.name}`}
                        className={cn(BADGE, 'bg-muted text-muted-foreground')}
                      >
                        {t(`plugins.mode.${plugin.mode}`)}
                      </span>
                    )}
                    <span
                      data-testid={`plugins-trust-${plugin.name}`}
                      className={cn(BADGE, TRUST_BADGE_CLASS[plugin.trustLevel])}
                    >
                      {t(`plugins.trust.${plugin.trustLevel}`)}
                    </span>
                    <span
                      data-testid={`plugins-scan-${plugin.name}`}
                      className={cn(BADGE, VERDICT_BADGE_CLASS[plugin.scanVerdict])}
                    >
                      {t(`plugins.scanVerdict.${plugin.scanVerdict}`)}
                    </span>
                    <span
                      data-testid={`plugins-active-${plugin.name}`}
                      className={cn(
                        BADGE,
                        plugin.active
                          ? 'bg-status-success/15 text-status-success'
                          : 'bg-muted text-muted-foreground',
                      )}
                    >
                      {plugin.active ? t('plugins.state.active') : t('plugins.state.inactive')}
                    </span>
                    <span
                      data-testid={`plugins-server-policy-${plugin.name}`}
                      className={cn(BADGE, SERVER_POLICY_BADGE_CLASS[plugin.serverPolicy])}
                    >
                      {t(`plugins.serverPolicy.${plugin.serverPolicy}`)}
                    </span>
                    {managed && (
                      <span
                        data-testid={`plugins-managed-${plugin.name}`}
                        className={cn(BADGE, 'bg-primary/15 text-primary')}
                      >
                        {t('plugins.managedBadge')}
                      </span>
                    )}
                  </div>

                  <div className="space-y-1 min-w-0">
                    <InfoField label={t('plugins.source')} value={plugin.source} mono />
                    <InfoField
                      label={t('plugins.contentHash')}
                      value={shortHash(plugin.contentHash)}
                      mono
                    />
                    {plugin.entry && (
                      <InfoField label={t('plugins.entry')} value={plugin.entry} mono />
                    )}
                    <InfoField
                      label={t('plugins.installedAt')}
                      value={formatDateTime(plugin.installedAt, locale)}
                    />
                    <InfoField
                      label={t('plugins.updatedAt')}
                      value={formatDateTime(plugin.updatedAt, locale)}
                    />
                  </div>

                  {managed && (
                    <p
                      data-testid={`plugins-managed-hint-${plugin.name}`}
                      className="text-xs text-muted-foreground break-words"
                    >
                      {t('plugins.managedHint')}
                    </p>
                  )}

                  {plugin.serverPolicy === 'unverified' && (
                    <p
                      data-testid={`plugins-server-policy-hint-${plugin.name}`}
                      className="text-xs text-muted-foreground break-words"
                    >
                      {t('plugins.serverPolicy.hint')}
                    </p>
                  )}

                  {canManage && (
                    <div className="flex flex-wrap items-center gap-2 min-w-0">
                      <Button
                        variant={plugin.active ? 'outline-muted' : 'primary'}
                        size="sm"
                        onClick={() => void handleToggleActive(plugin)}
                        disabled={busyNow || busy !== null}
                        data-testid={`plugins-${plugin.active ? 'disable' : 'enable'}-${plugin.name}`}
                      >
                        <Icon
                          name={plugin.active ? 'stop' : 'check'}
                          className="size-3.5"
                        />
                        {plugin.active ? t('plugins.disable') : t('plugins.enable')}
                      </Button>
                      {!managed && (
                        <>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => void handleUpdate(plugin)}
                            disabled={busyNow || busy !== null}
                            data-testid={`plugins-update-${plugin.name}`}
                          >
                            <Icon name="download" className="size-3.5" />
                            {t('plugins.update')}
                          </Button>
                          {(rollbackVersion ||
                            plugin.updatedAt !== plugin.installedAt) && (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => void handleRollback(plugin)}
                              disabled={busyNow || busy !== null}
                              title={t('plugins.rollbackHint')}
                              data-testid={`plugins-rollback-${plugin.name}`}
                            >
                              <Icon name="arrow-go-back" className="size-3.5" />
                              {t('plugins.rollback')}
                              {rollbackVersion ? ` ${rollbackVersion}` : ''}
                            </Button>
                          )}
                          <Button
                            variant="danger"
                            size="sm"
                            onClick={() => void handleRemove(plugin)}
                            disabled={busyNow || busy !== null}
                            data-testid={`plugins-remove-${plugin.name}`}
                          >
                            <Icon name="delete-bin" className="size-3.5" />
                            {t('plugins.remove')}
                          </Button>
                        </>
                      )}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </SettingsSection>

      {/* 2. Журнал действий плагинов: что установлено/отклонено и почему (ADR-090). */}
      <SettingsSection
        id="plugins-audit"
        title={t('plugins.audit.title')}
        description={t('plugins.audit.description')}
        tooltip={t('settings.help.plugins.section.plugins-audit')}
      >
        {auditError && (
          <div
            role="alert"
            data-testid="plugins-audit-error"
            className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive break-words"
          >
            {auditError}
          </div>
        )}

        {auditLoading && !audit && (
          <div className="py-3 text-center text-xs text-muted-foreground">{t('common.loading')}</div>
        )}

        {audit && audit.length === 0 && (
          <div
            className="flex flex-col items-center gap-1 py-4 text-center text-muted-foreground"
            data-testid="plugins-audit-empty"
          >
            <Icon name="file-list" className="size-6 opacity-40" />
            <p className="text-xs">{t('plugins.audit.empty')}</p>
          </div>
        )}

        {audit && audit.length > 0 && (
          <ul className="space-y-1.5 min-w-0" data-testid="plugins-audit-list">
            {audit.map((entry) => (
              <li
                key={entry.id}
                data-testid={`plugins-audit-item-${entry.id}`}
                className="space-y-1 rounded-lg border border-border/60 bg-surface-inset p-2.5 min-w-0"
              >
                <div className="flex flex-wrap items-center gap-1.5 min-w-0">
                  <span className="text-sm font-medium text-foreground break-words min-w-0">
                    {entry.plugin}
                  </span>
                  <span
                    data-testid={`plugins-audit-action-${entry.id}`}
                    className={cn(BADGE, 'bg-muted text-muted-foreground font-mono')}
                  >
                    {entry.action}
                  </span>
                  <span
                    data-testid={`plugins-audit-outcome-${entry.id}`}
                    className={cn(BADGE, AUDIT_OUTCOME_BADGE_CLASS[entry.outcome])}
                  >
                    {t(`plugins.audit.outcome.${entry.outcome}`)}
                  </span>
                  <span className="text-xs text-muted-foreground break-words min-w-0">
                    {formatDateTime(entry.ts, locale)}
                  </span>
                </div>
                {entry.reason && (
                  <p
                    data-testid={`plugins-audit-reason-${entry.id}`}
                    className="text-xs text-muted-foreground font-mono break-words"
                  >
                    {entry.reason}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}

        <div className="flex flex-wrap items-center gap-2 min-w-0">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void loadAudit()}
            disabled={auditLoading}
            data-testid="plugins-audit-refresh"
          >
            <Icon name="refresh" className={cn('size-3.5', auditLoading && 'animate-spin')} />
            {t('plugins.audit.refresh')}
          </Button>
        </div>
      </SettingsSection>

      {/* 3. Установка: источник + доверие; в managed локальные источники запрещены. */}
      <SettingsSection
        id="plugins-install"
        title={t('plugins.install.title')}
        description={t('plugins.install.description')}
        tooltip={t('settings.help.plugins.section.plugins-install')}
      >
        <TextField
          label={t('plugins.install.ref')}
          description={t('plugins.install.refHint')}
          placeholder={t('plugins.install.refPlaceholder')}
          value={installRef}
          onChange={(e) => {
            setInstallRef(e.target.value)
            setInstallError(null)
          }}
          disabled={!canManage || installing}
          mono
          id="plugins-install-ref"
          data-testid="plugins-install-ref"
        />

        <TextField
          label={t('plugins.install.sha256')}
          description={t('plugins.install.sha256Hint')}
          placeholder={t('plugins.install.sha256Placeholder')}
          value={installSha}
          onChange={(e) => {
            setInstallSha(e.target.value)
            setInstallError(null)
          }}
          disabled={!canManage || installing}
          mono
          id="plugins-install-sha256"
          data-testid="plugins-install-sha256"
        />

        <SelectField
          label={t('plugins.install.trust')}
          description={t('plugins.install.trustHint')}
          value={installTrust}
          onValueChange={(value) => setInstallTrust(value as PluginTrustLevel)}
          ariaLabel={t('plugins.install.trust')}
          disabled={!canManage || installing}
          triggerTestId="plugins-install-trust"
        >
          <SelectContent>
            {INSTALL_TRUST_LEVELS.map((level) => (
              <SelectItem key={level} value={level}>
                {t(`plugins.trust.${level}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </SelectField>

        <p className="text-xs text-muted-foreground break-words">
          {t('plugins.install.managedHint')}
        </p>

        {installError && (
          <p
            role="alert"
            data-testid="plugins-install-error"
            className="text-xs text-destructive break-words"
          >
            {installError}
          </p>
        )}

        {canManage && (
          <div className="flex flex-wrap items-center gap-2 min-w-0">
            <Button
              variant="primary"
              size="sm"
              onClick={() => void handleInstall()}
              disabled={installing || !installRef.trim()}
              data-testid="plugins-install-submit"
            >
              <Icon name="download" className={cn('size-3.5', installing && 'animate-pulse')} />
              {installing ? t('plugins.install.installing') : t('plugins.install.submit')}
            </Button>
          </div>
        )}
      </SettingsSection>

      {/* 4. Политика слоя: ключевые значения и обновление через PUT/DELETE. */}
      <SettingsSection
        id="plugins-policy"
        title={t('plugins.settings.title')}
        description={t('plugins.settings.description')}
        tooltip={t('settings.help.plugins.section.plugins-policy')}
      >
        {settingsError && (
          <div
            role="alert"
            data-testid="plugins-settings-error"
            className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive break-words"
          >
            {settingsError}
          </div>
        )}

        {settingsLoading && !settings && (
          <div className="py-3 text-center text-xs text-muted-foreground">{t('common.loading')}</div>
        )}

        {restartRequired && (
          <div
            data-testid="plugins-restart"
            className="flex flex-wrap items-start justify-between gap-2 rounded-lg bg-status-warning/10 p-3 text-xs text-status-warning min-w-0"
          >
            <span className="flex min-w-0 items-start gap-2">
              <Icon name="refresh" className="mt-0.5 size-3.5 shrink-0" />
              <span className="min-w-0 break-words">{t('plugins.settings.restartRequired')}</span>
            </span>
            {canManage && (
              <Button
                variant="outline"
                size="sm"
                className="shrink-0"
                onClick={() => void handleRestart()}
                disabled={restarting}
                data-testid="plugins-restart-button"
              >
                <Icon name="refresh" className={cn('size-3.5', restarting && 'animate-spin')} />
                {t('plugins.restart.button')}
              </Button>
            )}
          </div>
        )}

        {policy && (
          <>
            <ToggleField
              label={t('plugins.settings.executionEnabled')}
              description={t('plugins.settings.executionEnabledHint')}
              enabled={policy.executionEnabled}
              disabled={!canManage}
              onToggle={() => draft.update({ executionEnabled: !policy.executionEnabled })}
              ariaLabel={t('plugins.settings.executionEnabled')}
            />

            <ToggleField
              label={t('plugins.settings.enabled')}
              description={t('plugins.settings.enabledHint')}
              enabled={policy.enabled}
              disabled={!canManage}
              onToggle={() => draft.update({ enabled: !policy.enabled })}
              ariaLabel={t('plugins.settings.enabled')}
            />

            <SelectField
              label={t('plugins.settings.runtimeInstall')}
              description={t('plugins.settings.runtimeInstallHint')}
              value={policy.runtimeInstall}
              onValueChange={(value) =>
                draft.update({ runtimeInstall: value as PluginsPolicyValues['runtimeInstall'] })
              }
              ariaLabel={t('plugins.settings.runtimeInstall')}
              disabled={!canManage}
              triggerTestId="plugins-policy-runtime-install"
            >
              <SelectContent>
                <SelectItem value="allow">{t('plugins.settings.runtimeInstall.allow')}</SelectItem>
                <SelectItem value="deny">{t('plugins.settings.runtimeInstall.deny')}</SelectItem>
              </SelectContent>
            </SelectField>

            <SelectField
              label={t('plugins.settings.trustFloor')}
              description={t('plugins.settings.trustFloorHint')}
              value={policy.trustFloor}
              onValueChange={(value) =>
                draft.update({ trustFloor: value as PluginTrustLevel })
              }
              ariaLabel={t('plugins.settings.trustFloor')}
              disabled={!canManage}
              triggerTestId="plugins-policy-trust-floor"
            >
              <SelectContent>
                {TRUST_FLOOR_LEVELS.map((level) => (
                  <SelectItem key={level} value={level}>
                    {t(`plugins.trust.${level}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </SelectField>

            <SelectField
              label={t('plugins.settings.scan')}
              description={t('plugins.settings.scanHint')}
              value={policy.scan}
              onValueChange={(value) =>
                draft.update({ scan: value as PluginsPolicyValues['scan'] })
              }
              ariaLabel={t('plugins.settings.scan')}
              disabled={!canManage}
              triggerTestId="plugins-policy-scan"
            >
              <SelectContent>
                <SelectItem value="enabled">{t('plugins.settings.scan.enabled')}</SelectItem>
                <SelectItem value="disabled">{t('plugins.settings.scan.disabled')}</SelectItem>
              </SelectContent>
            </SelectField>

            <NumberField
              label={t('plugins.settings.promptBlockMaxChars')}
              description={t('plugins.settings.promptBlockMaxCharsHint')}
              value={policy.promptBlockMaxChars}
              min={1}
              disabled={!canManage}
              onChange={(e) =>
                draft.update({ promptBlockMaxChars: Number(e.target.value) || 1 })
              }
              id="plugins-policy-prompt-block"
              data-testid="plugins-policy-prompt-block"
            />

            <NumberField
              label={t('plugins.settings.llmFilterTimeoutMs')}
              description={t('plugins.settings.llmFilterTimeoutMsHint')}
              value={policy.llmFilterTimeoutMs}
              min={1}
              suffix="ms"
              disabled={!canManage}
              onChange={(e) =>
                draft.update({ llmFilterTimeoutMs: Number(e.target.value) || 1 })
              }
              id="plugins-policy-llm-filter-timeout"
              data-testid="plugins-policy-llm-filter-timeout"
            />

            {canManage && (
              <SettingsActions
                onSave={() => void handleSavePolicy()}
                onCancel={() => draft.revert()}
                onReset={() => void handleResetPolicy()}
                saving={saving}
                saveDisabled={!draft.dirty}
                cancelDisabled={!draft.dirty}
                resetDisabled={!settings?.isOverridden}
                isDefault={draft.isDefault && !settings?.isOverridden}
                saveTestId="plugins-policy-save"
                cancelTestId="plugins-policy-cancel"
                resetTestId="plugins-policy-reset"
              />
            )}
          </>
        )}
      </SettingsSection>
    </SettingsPanel>
  )
}
