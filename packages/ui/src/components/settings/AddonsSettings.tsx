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
import { InfoField, SettingsPanel, SettingsSection, SelectField, Tabs } from '../ui/settings'
import {
  synthApi,
  type PackInstallation,
  type PackInstallationStatus,
  type PipelineDefinition,
  type PipelineInstance,
  type PipelineInstanceStatus,
} from '@/lib/api/synthApi'

/**
 * ADR-086 §5 / ADR-051 (ADR-100): админ-раздел «Аддоны» — реестр установленных
 * пакетов расширений и пайплайны инстанса.
 *
 * Раздел — место, где администратор подтверждает пакет, ждущий одобрения
 * (`status: 'pending_approval'`): до одобрения артефакты пакета (агенты, скиллы,
 * MCP-серверы, пайплайны) в инстансе отсутствуют. Снятие установки удаляет
 * поставленные пакетом артефакты — действие только ADMIN и с подтверждением.
 *
 * Правда чтения: в core — `requireAuth`, в managed (backend) — ADMIN
 * (реестр инстанса). UI лишь прячет недоступные действия, enforcement — на
 * сервере.
 */

/** Статус HTTP-ошибки (403 — нет прав администратора). */
const statusOf = (err: unknown): number | undefined =>
  typeof (err as { status?: unknown })?.status === 'number'
    ? (err as { status: number }).status
    : undefined

/** Общий стиль бейджа статуса (как в соседних админ-разделах). */
const BADGE = 'shrink-0 rounded px-1.5 py-0.5 text-[0.625rem] font-medium'

/** Цвет бейджа статуса установки пакета. */
const PACK_STATUS_CLASS: Record<PackInstallationStatus, string> = {
  active: 'bg-status-success/15 text-status-success',
  pending_approval: 'bg-status-warning/15 text-status-warning',
  disabled: 'bg-muted text-muted-foreground',
}

/** Цвет бейджа статуса прогона пайплайна. */
const INSTANCE_STATUS_CLASS: Record<PipelineInstanceStatus, string> = {
  pending: 'bg-muted text-muted-foreground',
  running: 'bg-primary/15 text-primary',
  waiting: 'bg-status-warning/15 text-status-warning',
  done: 'bg-status-success/15 text-status-success',
  failed: 'bg-destructive/15 text-destructive',
  cancelled: 'bg-muted text-muted-foreground',
}

/** Статусы экземпляра — для фильтра (значения — контракт `pipelineInstanceStatusSchema`). */
const INSTANCE_STATUSES: PipelineInstanceStatus[] = [
  'pending',
  'running',
  'waiting',
  'done',
  'failed',
  'cancelled',
]

export function AddonsSettings() {
  const { t, locale } = useI18n()
  const { notify } = useNotification()
  const userRoles = useAuthStore((s) => s.user?.roles) ?? []
  const canManage = userRoles.includes('ADMIN')

  const [packs, setPacks] = useState<PackInstallation[] | null>(null)
  const [packsLoading, setPacksLoading] = useState(true)
  const [packsError, setPacksError] = useState<string | null>(null)
  const [busyPack, setBusyPack] = useState<string | null>(null)

  const [pipelines, setPipelines] = useState<PipelineDefinition[] | null>(null)
  const [instances, setInstances] = useState<PipelineInstance[] | null>(null)
  const [pipelinesLoading, setPipelinesLoading] = useState(true)
  const [pipelinesError, setPipelinesError] = useState<string | null>(null)

  const [pipelineTab, setPipelineTab] = useState('definitions')
  const [filterPipelineId, setFilterPipelineId] = useState('')
  const [filterStatus, setFilterStatus] = useState<PipelineInstanceStatus | ''>('')

  /** Понятная ошибка: 403 — «нужны права администратора», остальное — текст сервера. */
  const describeError = useCallback(
    (err: unknown, fallback: string): string =>
      statusOf(err) === 403 ? t('addons.forbidden') : fallback,
    [t],
  )

  const loadPacks = useCallback(async () => {
    setPacksLoading(true)
    setPacksError(null)
    try {
      setPacks(await synthApi.getPacks())
    } catch (err) {
      setPacksError(
        describeError(err, t('addons.packs.loadError', { error: err instanceof Error ? err.message : t('common.error') })),
      )
    } finally {
      setPacksLoading(false)
    }
  }, [describeError, t])

  const loadPipelines = useCallback(async () => {
    setPipelinesLoading(true)
    setPipelinesError(null)
    try {
      const [definitions, runs] = await Promise.all([
        synthApi.getPipelines(),
        synthApi.getPipelineInstances({
          ...(filterPipelineId ? { pipelineId: filterPipelineId } : {}),
          ...(filterStatus ? { status: filterStatus } : {}),
        }),
      ])
      setPipelines(definitions)
      setInstances(runs)
    } catch (err) {
      setPipelinesError(
        describeError(err, t('addons.pipelines.loadError', { error: err instanceof Error ? err.message : t('common.error') })),
      )
    } finally {
      setPipelinesLoading(false)
    }
  }, [describeError, filterPipelineId, filterStatus, t])

  useEffect(() => {
    void loadPacks()
  }, [loadPacks])

  useEffect(() => {
    void loadPipelines()
  }, [loadPipelines])

  /** Одобрение пакета: фактическая установка артефактов (только ADMIN). */
  const handleApprove = useCallback(
    async (pack: PackInstallation) => {
      if (busyPack) return
      const ok = await confirm({
        title: t('addons.packs.approveConfirmTitle'),
        message: t('addons.packs.approveConfirm', { name: pack.name }),
        confirmLabel: t('addons.packs.approve'),
        variant: 'warning',
        icon: 'check',
      })
      if (!ok) return
      setBusyPack(pack.name)
      try {
        await synthApi.approvePack(pack.name)
        await loadPacks()
        notify({ text: t('addons.packs.approved', { name: pack.name }), type: 'success', category: 'system' })
      } catch (err) {
        const message = describeError(
          err,
          t('addons.packs.approveError', { error: err instanceof Error ? err.message : t('common.error') }),
        )
        notify({ text: message, type: 'error', category: 'error' })
      } finally {
        setBusyPack(null)
      }
    },
    [busyPack, describeError, loadPacks, notify, t],
  )

  /** Снятие установки: удаляются все поставленные пакетом артефакты. */
  const handleUninstall = useCallback(
    async (pack: PackInstallation) => {
      if (busyPack) return
      const ok = await confirm({
        title: t('addons.packs.removeConfirmTitle'),
        message: t('addons.packs.removeConfirm', { name: pack.name }),
        confirmLabel: t('addons.packs.remove'),
        variant: 'danger',
        icon: 'delete-bin',
      })
      if (!ok) return
      setBusyPack(pack.name)
      try {
        await synthApi.uninstallPack(pack.name)
        await Promise.all([loadPacks(), loadPipelines()])
        notify({ text: t('addons.packs.removed', { name: pack.name }), type: 'success', category: 'system' })
      } catch (err) {
        const message = describeError(
          err,
          t('addons.packs.removeError', { error: err instanceof Error ? err.message : t('common.error') }),
        )
        notify({ text: message, type: 'error', category: 'error' })
      } finally {
        setBusyPack(null)
      }
    },
    [busyPack, describeError, loadPacks, loadPipelines, notify, t],
  )

  const pendingCount = useMemo(
    () => (packs ?? []).filter((pack) => pack.status === 'pending_approval').length,
    [packs],
  )

  return (
    <SettingsPanel
      title={t('addons.title')}
      description={t('addons.description')}
      meta={t('addons.packs.count', { count: packs?.length ?? 0 })}
    >
      {/* 1. Пакеты расширений: реестр установок, одобрение и снятие (ADMIN). */}
      <SettingsSection
        id="addons-packs"
        title={t('addons.packs.title')}
        description={t('addons.packs.description')}
        tooltip={t('settings.help.addons.section.addons-packs')}
      >
        {packsError && (
          <div
            role="alert"
            data-testid="addons-packs-error"
            className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive break-words"
          >
            {packsError}
          </div>
        )}

        {packsLoading && !packs && (
          <div className="py-3 text-center text-xs text-muted-foreground">{t('common.loading')}</div>
        )}

        {packs && packs.length === 0 && (
          <div
            className="flex flex-col items-center gap-1 py-4 text-center text-muted-foreground"
            data-testid="addons-packs-empty"
          >
            <Icon name="rocket" className="size-6 opacity-40" />
            <p className="text-xs">{t('addons.packs.empty')}</p>
          </div>
        )}

        {packs && packs.length > 0 && (
          <ul className="space-y-2 min-w-0" data-testid="addons-packs-list">
            {packs.map((pack) => {
              const pending = pack.status === 'pending_approval'
              const busy = busyPack === pack.name
              return (
                <li
                  key={pack.name}
                  data-testid={`addons-pack-${pack.name}`}
                  className={cn(
                    'space-y-2 rounded-lg border border-border/60 bg-surface-inset p-2.5 min-w-0',
                    pending && 'border-status-warning/40 bg-status-warning/10',
                  )}
                >
                  <div className="flex flex-wrap items-center gap-1.5 min-w-0">
                    <span className="text-sm font-medium text-foreground break-words min-w-0">
                      {pack.name}
                    </span>
                    {pack.version && (
                      <span className={cn(BADGE, 'bg-muted text-muted-foreground font-mono')}>
                        {pack.version}
                      </span>
                    )}
                    <span className={cn(BADGE, 'bg-muted text-muted-foreground')}>{pack.kind}</span>
                    <span
                      data-testid={`addons-pack-status-${pack.name}`}
                      className={cn(BADGE, PACK_STATUS_CLASS[pack.status])}
                    >
                      {t(`addons.packs.status.${pack.status}`)}
                    </span>
                    {pending && (
                      <span
                        data-testid={`addons-pack-pending-${pack.name}`}
                        className={cn(BADGE, 'bg-status-warning/15 text-status-warning')}
                      >
                        {t('addons.packs.pendingBadge')}
                      </span>
                    )}
                  </div>

                  {pack.description && (
                    <p className="text-xs text-muted-foreground break-words">{pack.description}</p>
                  )}

                  <div className="space-y-1 min-w-0">
                    <InfoField
                      label={t('addons.packs.installedAt')}
                      value={formatDateTime(pack.installedAt, locale)}
                    />
                    <InfoField
                      label={t('addons.packs.provides.agents')}
                      value={pack.provides?.agents?.join(', ') || '—'}
                    />
                    <InfoField
                      label={t('addons.packs.provides.skills')}
                      value={pack.provides?.skills?.join(', ') || '—'}
                    />
                    <InfoField
                      label={t('addons.packs.provides.mcp')}
                      value={pack.provides?.mcp?.join(', ') || '—'}
                    />
                    <InfoField
                      label={t('addons.packs.provides.pipelines')}
                      value={pack.provides?.pipelines?.join(', ') || '—'}
                    />
                  </div>

                  {canManage && (
                    <div className="flex flex-wrap items-center gap-2 min-w-0">
                      {pending && (
                        <Button
                          variant="primary"
                          size="sm"
                          onClick={() => void handleApprove(pack)}
                          disabled={busy || busyPack !== null}
                          data-testid={`addons-pack-approve-${pack.name}`}
                        >
                          <Icon name="check" className="size-3.5" />
                          {t('addons.packs.approve')}
                        </Button>
                      )}
                      {pack.status === 'active' && (
                        <Button
                          variant="danger"
                          size="sm"
                          onClick={() => void handleUninstall(pack)}
                          disabled={busy || busyPack !== null}
                          data-testid={`addons-pack-remove-${pack.name}`}
                        >
                          <Icon name="delete-bin" className="size-3.5" />
                          {t('addons.packs.remove')}
                        </Button>
                      )}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}

        {pendingCount > 0 && (
          <p data-testid="addons-pending-hint" className="text-xs text-status-warning break-words">
            {t('addons.packs.pendingHint', { count: pendingCount })}
          </p>
        )}
      </SettingsSection>

      {/* 2. Пайплайны: определения (ставит пакет) и прогоны автоматов. */}
      <SettingsSection
        id="addons-pipelines"
        title={t('addons.pipelines.title')}
        description={t('addons.pipelines.description')}
        tooltip={t('settings.help.addons.section.addons-pipelines')}
      >
        {pipelinesError && (
          <div
            role="alert"
            data-testid="addons-pipelines-error"
            className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive break-words"
          >
            {pipelinesError}
          </div>
        )}

        {pipelinesLoading && !pipelines && (
          <div className="py-3 text-center text-xs text-muted-foreground">{t('common.loading')}</div>
        )}

        <Tabs
          items={[
            { value: 'definitions', label: t('addons.pipelines.definitions') },
            { value: 'instances', label: t('addons.pipelines.instances') },
          ]}
          value={pipelineTab}
          onChange={setPipelineTab}
          ariaLabel={t('addons.pipelines.title')}
        />

        {pipelineTab === 'definitions' && (
          <div className="space-y-2 min-w-0">
            {pipelines && pipelines.length === 0 && (
              <div
                className="flex flex-col items-center gap-1 py-4 text-center text-muted-foreground"
                data-testid="addons-pipelines-empty"
              >
                <Icon name="git-branch" className="size-6 opacity-40" />
                <p className="text-xs">{t('addons.pipelines.empty')}</p>
              </div>
            )}

            {pipelines && pipelines.length > 0 && (
              <ul className="space-y-2 min-w-0" data-testid="addons-pipelines-list">
                {pipelines.map((pipeline) => (
                  <li
                    key={pipeline.id}
                    data-testid={`addons-pipeline-${pipeline.id}`}
                    className="space-y-1 rounded-lg border border-border/60 bg-surface-inset p-2.5 min-w-0"
                  >
                    <div className="flex flex-wrap items-center gap-1.5 min-w-0">
                      <span className="text-sm font-medium text-foreground break-words min-w-0">
                        {pipeline.name}
                      </span>
                      <span className={cn(BADGE, 'bg-muted text-muted-foreground font-mono')}>
                        {pipeline.id}
                      </span>
                      {pipeline.version && (
                        <span className={cn(BADGE, 'bg-muted text-muted-foreground font-mono')}>
                          {pipeline.version}
                        </span>
                      )}
                    </div>
                    {pipeline.description && (
                      <p className="text-xs text-muted-foreground break-words">{pipeline.description}</p>
                    )}
                    <div className="space-y-1 min-w-0">
                      <InfoField
                        label={t('addons.pipelines.steps')}
                        value={String(pipeline.steps?.length ?? 0)}
                      />
                      {/* Провенанс: только имя пакета расширения (ADR-086 §5). */}
                      {pipeline.installedBy?.pack && (
                        <InfoField
                          label={t('addons.pipelines.installedBy')}
                          value={pipeline.installedBy.pack}
                        />
                      )}
                      <InfoField
                        label={t('addons.pipelines.createdAt')}
                        value={formatDateTime(pipeline.createdAt, locale)}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {pipelineTab === 'instances' && (
          <div className="space-y-3 min-w-0">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 min-w-0">
              <SelectField
                label={t('addons.pipelines.filter.pipeline')}
                value={filterPipelineId}
                onValueChange={setFilterPipelineId}
                ariaLabel={t('addons.pipelines.filter.pipeline')}
                triggerTestId="addons-pipeline-filter"
              >
                <SelectContent>
                  <SelectItem value="">{t('addons.pipelines.filter.all')}</SelectItem>
                  {(pipelines ?? []).map((pipeline) => (
                    <SelectItem key={pipeline.id} value={pipeline.id}>
                      {pipeline.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </SelectField>

              <SelectField
                label={t('addons.pipelines.filter.status')}
                value={filterStatus}
                onValueChange={(value) => setFilterStatus(value as PipelineInstanceStatus | '')}
                ariaLabel={t('addons.pipelines.filter.status')}
                triggerTestId="addons-instance-status-filter"
              >
                <SelectContent>
                  <SelectItem value="">{t('addons.pipelines.filter.all')}</SelectItem>
                  {INSTANCE_STATUSES.map((status) => (
                    <SelectItem key={status} value={status}>
                      {t(`addons.pipelines.instanceStatus.${status}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </SelectField>
            </div>

            {instances && instances.length === 0 && (
              <div
                className="flex flex-col items-center gap-1 py-4 text-center text-muted-foreground"
                data-testid="addons-instances-empty"
              >
                <Icon name="time" className="size-6 opacity-40" />
                <p className="text-xs">{t('addons.pipelines.instancesEmpty')}</p>
              </div>
            )}

            {instances && instances.length > 0 && (
              <ul className="space-y-2 min-w-0" data-testid="addons-instances-list">
                {instances.map((instance) => (
                  <li
                    key={instance.id}
                    data-testid={`addons-instance-${instance.id}`}
                    className="space-y-1 rounded-lg border border-border/60 bg-surface-inset p-2.5 min-w-0"
                  >
                    <div className="flex flex-wrap items-center gap-1.5 min-w-0">
                      <span className={cn(BADGE, 'bg-muted text-muted-foreground font-mono')}>
                        {instance.id}
                      </span>
                      <span className="text-sm text-foreground break-words min-w-0">
                        {instance.pipelineId}
                      </span>
                      <span
                        data-testid={`addons-instance-status-${instance.id}`}
                        className={cn(BADGE, INSTANCE_STATUS_CLASS[instance.status])}
                      >
                        {t(`addons.pipelines.instanceStatus.${instance.status}`)}
                      </span>
                    </div>
                    <div className="space-y-1 min-w-0">
                      {instance.currentStep && (
                        <InfoField
                          label={t('addons.pipelines.currentStep')}
                          value={instance.currentStep}
                        />
                      )}
                      <InfoField
                        label={t('addons.pipelines.attempts')}
                        value={String(instance.attempts ?? 0)}
                      />
                      <InfoField
                        label={t('addons.pipelines.createdAt')}
                        value={formatDateTime(instance.createdAt, locale)}
                      />
                    </div>
                    {instance.error && (
                      <p className="text-xs text-destructive break-words">{instance.error}</p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </SettingsSection>
    </SettingsPanel>
  )
}
