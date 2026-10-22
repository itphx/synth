import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

import type {
  AnalyticsDimension,
  AnalyticsExportFormat,
  AnalyticsReport,
  AnalyticsSummary,
} from '@itphx/synth-shared/types'
import { Dialog, DialogClose, DialogContent } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import { SegmentedControl } from '@/components/ui/settings'
import { Icon } from '@/components/icon/Icon'
import type { IconName } from '@/components/icon/icons'
import { useI18n } from '@/lib/i18n'
import { synthApi } from '@/lib/api/synthApi'
import type { AnalyticsQuery, UserInfo } from '@/lib/api/synthApi'
import { formatCostMap, formatTokens, formatTps } from '@/lib/formatStats'
import { cn } from '@/lib/utils'
import { useDevice } from '@/hooks/useDevice'
import { useNotification } from '@/hooks/useNotification'
import { useAuthStore } from '@/stores/authStore'
import { useUIStore } from '@/stores/useUIStore'
import { useProjectsStore } from '@/stores/projectsStore'
import { useAgentsStore } from '@/stores/agentsStore'
import { useProvidersStore } from '@/stores/providersStore'
import { AnalyticsTable } from './AnalyticsTable'
import {
  AnalyticsPrintReport,
  type AnalyticsPrintFilter,
  type AnalyticsPrintSnapshot,
} from './AnalyticsPrintReport'
import { computeAnalyticsTotals } from './analytics-model'
import {
  defaultCustomPeriod,
  resolveAnalyticsPeriod,
  type AnalyticsPeriod,
  type AnalyticsPreset,
} from './analytics-range'
import { ANALYTICS_TABS, type AnalyticsTab } from './analytics-types'

interface TabMeta {
  labelKey: string
  icon: IconName
}

/** ADR-102 §5: четыре вкладки отчёта (состояние внутри модалки, не роут). */
const TAB_META: Record<AnalyticsTab, TabMeta> = {
  usage: { labelKey: 'analytics.tab.usage', icon: 'chart-line' },
  activity: { labelKey: 'analytics.tab.activity', icon: 'bar-chart-2' },
  decision: { labelKey: 'analytics.tab.decision', icon: 'cpu' },
  prompt: { labelKey: 'analytics.tab.prompt', icon: 'brain' },
}

interface GroupOption {
  value: string
  labelKey: string
}

/** Оси группировки по вкладке — только те, что реально есть в семействе (§2). */
const GROUP_OPTIONS: Record<AnalyticsTab, GroupOption[]> = {
  usage: [
    { value: 'day', labelKey: 'analytics.axis.day' },
    { value: 'user', labelKey: 'analytics.axis.user' },
    { value: 'project', labelKey: 'analytics.axis.project' },
    { value: 'model', labelKey: 'analytics.axis.model' },
    { value: 'agent', labelKey: 'analytics.axis.agent' },
  ],
  activity: [
    { value: 'day', labelKey: 'analytics.axis.day' },
    { value: 'user', labelKey: 'analytics.axis.user' },
    { value: 'project', labelKey: 'analytics.axis.project' },
  ],
  decision: [
    { value: 'day', labelKey: 'analytics.axis.day' },
    { value: 'model', labelKey: 'analytics.axis.model' },
    { value: 'provider', labelKey: 'analytics.axis.provider' },
  ],
  prompt: [
    { value: 'model_agent', labelKey: 'analytics.group.modelAgent' },
    { value: 'model', labelKey: 'analytics.axis.model' },
    { value: 'agent', labelKey: 'analytics.axis.agent' },
  ],
}

const DEFAULT_GROUP: Record<AnalyticsTab, string> = {
  usage: 'day',
  activity: 'day',
  decision: 'day',
  prompt: 'model_agent',
}

interface FiltersState {
  userId: string
  projectId: string
  model: string
  agent: string
}

/** Оси группировки из значения селекта (у `prompt` — пара «модель + агент»). */
function groupByDimensions(tab: AnalyticsTab, value: string): AnalyticsDimension[] {
  if (tab === 'prompt' && value === 'model_agent') return ['model', 'agent']
  return [value as AnalyticsDimension]
}

/**
 * Query текущего отчёта: фильтры отправляются только для применимых к семейству
 * осей (ADR-102 §2) — иначе сервер получил бы бессмысленный фильтр.
 */
function buildQuery(
  tab: AnalyticsTab,
  groupValue: string,
  period: AnalyticsPeriod,
  filters: FiltersState,
): AnalyticsQuery {
  const query: AnalyticsQuery = {
    from: period.from,
    to: period.to,
    groupBy: groupByDimensions(tab, groupValue),
  }
  if (tab === 'usage') {
    query.userId = filters.userId || undefined
    query.projectId = filters.projectId || undefined
    query.model = filters.model || undefined
    query.agent = filters.agent || undefined
  } else if (tab === 'activity') {
    query.userId = filters.userId || undefined
    query.projectId = filters.projectId || undefined
  } else if (tab === 'decision') {
    query.model = filters.model || undefined
  } else {
    query.model = filters.model || undefined
    query.agent = filters.agent || undefined
  }
  return query
}

/** 403 (RBAC) — не ошибка загрузки: показываем «недоступно для роли», без ретраев. */
function isForbidden(error: unknown): boolean {
  const value = error as { status?: number; code?: string } | null
  return value?.status === 403 || value?.code === 'FORBIDDEN'
}

async function requestReport(tab: AnalyticsTab, query: AnalyticsQuery): Promise<AnalyticsReport> {
  switch (tab) {
    case 'usage':
      return synthApi.getAnalyticsUsage(query)
    case 'activity':
      return synthApi.getAnalyticsActivity(query)
    case 'decision':
      return synthApi.getAnalyticsDecision(query)
    case 'prompt':
      return synthApi.getAnalyticsPrompt(query)
  }
}

/** Скачивание blob с серверным именем файла (`Content-Disposition`). */
function triggerDownload(file: { blob: Blob; filename: string }): void {
  const url = URL.createObjectURL(file.blob)
  const link = document.createElement('a')
  link.href = url
  link.download = file.filename
  link.rel = 'noopener'
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

function percent(value: number | undefined): string {
  return `${((value ?? 0) * 100).toFixed(1)}%`
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-xl border border-border/70 bg-card px-3 py-2">
      <div className="truncate text-[0.7rem] text-muted-foreground">{label}</div>
      <div className="truncate text-base font-semibold tabular-nums text-foreground">{value}</div>
    </div>
  )
}

function CardGrid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">{children}</div>
}

function FilterSelect({
  label,
  value,
  items,
  onChange,
  touch,
}: {
  label: string
  value: string
  items: ReadonlyArray<{ value: string; label: string }>
  onChange: (value: string) => void
  touch?: boolean
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="truncate text-[0.7rem] text-muted-foreground">{label}</span>
      <Select value={value} onValueChange={onChange} items={items}>
        <SelectTrigger
          className={cn('min-w-[8.5rem] max-w-[12rem]', touch ? 'h-10' : 'h-8')}
          aria-label={label}
        >
          <span className="min-w-0 flex-1 truncate text-left">
            {items.find((item) => item.value === value)?.label ?? value}
          </span>
          <Icon name="arrow-down-s" className="size-3.5 shrink-0 opacity-50" />
        </SelectTrigger>
        <SelectContent>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

function ForbiddenNotice() {
  const { t } = useI18n()
  return (
    <div
      className="flex flex-col items-center justify-center gap-2 rounded-xl border border-border/70 px-6 py-10 text-center"
      data-testid="analytics-forbidden"
    >
      <Icon name="shield-keyhole" className="size-6 text-muted-foreground" />
      <p className="text-sm font-medium text-foreground">{t('analytics.forbidden')}</p>
      <p className="max-w-md text-xs text-muted-foreground">{t('analytics.forbiddenHint')}</p>
    </div>
  )
}

/**
 * ADR-102 §5 (волна 2): модальное окно «Аналитика и отчёты». Лениво
 * монтируется из `App.tsx` при первом открытии (по образцу `LogsModal`).
 *
 * Вкладки — состояние внутри окна; данные читаются с сервера по фильтрам.
 * `decision` и `summary` для обычного `USER` сервер отдаёт 403 — показываем
 * понятное сообщение и не повторяем запрос (эффект зависит только от фильтров).
 */
export function AnalyticsModal() {
  const { t } = useI18n()
  const { notify } = useNotification()
  const { deviceType } = useDevice()
  const isPhone = deviceType === 'phone'
  const touch = deviceType !== 'desktop'

  const isOpen = useUIStore((s) => s.isAnalyticsDialogOpen)
  const setOpen = useUIStore((s) => s.setAnalyticsDialogOpen)
  const user = useAuthStore((s) => s.user)
  const projects = useProjectsStore((s) => s.projects)
  const agents = useAgentsStore((s) => s.agents)
  const models = useProvidersStore((s) => s.models)

  const roles = user?.roles ?? []
  const canSelectUser = roles.some(
    (role) => role === 'ADMIN' || role === 'LEAD' || role === 'AUDITOR',
  )

  const [tab, setTab] = useState<AnalyticsTab>('usage')
  const [preset, setPreset] = useState<AnalyticsPreset>('30d')
  const customDefaults = useMemo(() => defaultCustomPeriod(), [])
  const [customFrom, setCustomFrom] = useState(customDefaults.from)
  const [customTo, setCustomTo] = useState(customDefaults.to)
  const [filters, setFilters] = useState<FiltersState>({
    userId: '',
    projectId: '',
    model: '',
    agent: '',
  })
  const [groups, setGroups] = useState<Record<AnalyticsTab, string>>(DEFAULT_GROUP)
  const [users, setUsers] = useState<UserInfo[]>([])

  const [report, setReport] = useState<AnalyticsReport | null>(null)
  const [summary, setSummary] = useState<AnalyticsSummary | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [forbidden, setForbidden] = useState(false)
  const [summaryForbidden, setSummaryForbidden] = useState(false)
  const [exporting, setExporting] = useState<AnalyticsExportFormat | null>(null)
  const [printSnapshot, setPrintSnapshot] = useState<AnalyticsPrintSnapshot | null>(null)
  const [retryTick, setRetryTick] = useState(0)

  const period = useMemo(
    () => resolveAnalyticsPeriod(preset, customFrom, customTo),
    [preset, customFrom, customTo],
  )
  const groupValue = groups[tab]
  const query = useMemo(
    () => buildQuery(tab, groupValue, period, filters),
    [tab, groupValue, period, filters],
  )

  // Справочники для селектов (ленивые сторы грузятся при первом открытии окна).
  useEffect(() => {
    void useProjectsStore.getState().loadProjects()
    void useAgentsStore.getState().loadAgents()
    void useProvidersStore.getState().loadModels()
  }, [])

  // Список пользователей — только для сквозного обзора (иначе сервер вернёт 403).
  useEffect(() => {
    if (!canSelectUser) return
    let cancelled = false
    synthApi
      .getUsers()
      .then((response) => {
        if (!cancelled) setUsers(response.users)
      })
      .catch(() => {
        // Нет прав/гибрид/старый сервер — фильтр по пользователю просто пуст.
      })
    return () => {
      cancelled = true
    }
  }, [canSelectUser])

  // Отчёт текущей вкладки. 403 фиксируется состоянием — повторного запроса нет.
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setForbidden(false)
    // Не показываем данные предыдущей вкладки с чужими колонками.
    setReport(null)
    const run = async () => {
      try {
        const next = await requestReport(tab, query)
        if (!cancelled) setReport(next)
      } catch (cause) {
        if (cancelled) return
        setReport(null)
        if (isForbidden(cause)) setForbidden(true)
        else setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [tab, query, retryTick])

  // Сводка инстанса — только для вкладок, где она есть (`usage`/`activity`).
  useEffect(() => {
    if (tab !== 'usage' && tab !== 'activity') {
      setSummary(null)
      setSummaryForbidden(false)
      return
    }
    let cancelled = false
    setSummaryForbidden(false)
    synthApi
      .getAnalyticsSummary({ from: period.from, to: period.to })
      .then((next) => {
        if (!cancelled) setSummary(next)
      })
      .catch((cause) => {
        if (cancelled) return
        setSummary(null)
        setSummaryForbidden(isForbidden(cause))
      })
    return () => {
      cancelled = true
    }
  }, [tab, period.from, period.to])

  // Данные прошлой вкладки не показываем даже один кадр (эффект очистки — после paint).
  const visibleReport = report && report.report === tab ? report : null
  const totals = useMemo(() => computeAnalyticsTotals(visibleReport), [visibleReport])

  const userItems = useMemo(
    () => [
      { value: '', label: t('analytics.filter.all') },
      ...users.map((item) => ({
        value: item.id,
        label: item.display_name || item.username || item.id,
      })),
    ],
    [users, t],
  )
  const projectItems = useMemo(
    () => [
      { value: '', label: t('analytics.filter.all') },
      ...projects.map((project) => ({ value: project.id, label: project.name })),
    ],
    [projects, t],
  )
  const modelItems = useMemo(
    () => [
      { value: '', label: t('analytics.filter.all') },
      ...models.map((model) => ({ value: model.id, label: model.name || model.id })),
    ],
    [models, t],
  )
  const agentItems = useMemo(
    () => [
      { value: '', label: t('analytics.filter.all') },
      ...agents.map((agent) => ({
        value: agent.id,
        label: agent.display_name || agent.id,
      })),
    ],
    [agents, t],
  )

  const showUser = (tab === 'usage' || tab === 'activity') && canSelectUser
  const showProject = tab === 'usage' || tab === 'activity'
  const showModel = tab === 'usage' || tab === 'decision' || tab === 'prompt'
  const showAgent = tab === 'usage' || tab === 'prompt'

  const filterLabels = useMemo<AnalyticsPrintFilter[]>(() => {
    const list: AnalyticsPrintFilter[] = []
    if (showUser && filters.userId) {
      const match = users.find((item) => item.id === filters.userId)
      list.push({
        label: t('analytics.filter.user'),
        value: match?.display_name || match?.username || filters.userId,
      })
    }
    if (showProject && filters.projectId) {
      const match = projects.find((project) => project.id === filters.projectId)
      list.push({
        label: t('analytics.filter.project'),
        value: match?.name || filters.projectId,
      })
    }
    if (showModel && filters.model) {
      const match = models.find((model) => model.id === filters.model)
      list.push({
        label: t('analytics.filter.model'),
        value: match?.name || filters.model,
      })
    }
    if (showAgent && filters.agent) {
      const match = agents.find((agent) => agent.id === filters.agent)
      list.push({
        label: t('analytics.filter.agent'),
        value: match?.display_name || filters.agent,
      })
    }
    return list
    // `t` меняется вместе с локалью — подписи пересобираются.
  }, [showUser, showProject, showModel, showAgent, filters, users, projects, models, agents, t])

  const handleExport = useCallback(
    async (format: AnalyticsExportFormat) => {
      setExporting(format)
      try {
        const file = await synthApi.getAnalyticsExport({ ...query, report: tab, format })
        triggerDownload(file)
      } catch (cause) {
        notify({
          text: isForbidden(cause) ? t('analytics.forbidden') : t('analytics.exportError'),
          type: 'error',
          category: 'error',
        })
      } finally {
        setExporting(null)
      }
    },
    [query, tab, notify, t],
  )

  const handlePrint = useCallback(() => {
    setPrintSnapshot({
      tab,
      from: period.from,
      to: period.to,
      filters: filterLabels,
      report: visibleReport,
      summary: tab === 'usage' || tab === 'activity' ? summary : null,
      forbidden,
    })
  }, [tab, period.from, period.to, filterLabels, visibleReport, summary, forbidden])

  // Печать: портал уже в DOM (эффект после рендера снимка) → системный диалог
  // печати; CSS `@media print` оставляет только отчёт.
  useEffect(() => {
    if (!printSnapshot) return
    const timer = window.setTimeout(() => {
      window.print()
    }, 50)
    return () => window.clearTimeout(timer)
  }, [printSnapshot])

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) {
        setPrintSnapshot(null)
        setExporting(null)
      }
      setOpen(next)
    },
    [setOpen],
  )

  /**
   * Смена вкладки: не применимые к семейству фильтры сбрасываются, чтобы
   * скрытый фильтр не сужал отчёт «невидимо» для пользователя.
   */
  const handleTabChange = useCallback((next: AnalyticsTab) => {
    setTab(next)
    setFilters((state) => ({
      userId: next === 'usage' || next === 'activity' ? state.userId : '',
      projectId: next === 'usage' || next === 'activity' ? state.projectId : '',
      model: next === 'usage' || next === 'decision' || next === 'prompt' ? state.model : '',
      agent: next === 'usage' || next === 'prompt' ? state.agent : '',
    }))
  }, [])

  const groupItems = GROUP_OPTIONS[tab].map((option) => ({
    value: option.value,
    label: t(option.labelKey),
  }))

  const exportDisabled = loading || forbidden || !visibleReport || visibleReport.rows.length === 0

  return (
    <>
      <Dialog open={isOpen} onOpenChange={handleOpenChange}>
        <DialogContent
          className={cn(
            'gap-0 overflow-hidden p-0 shadow-xl',
            isPhone
              ? '-m-4 h-[100dvh] max-h-none w-screen max-w-none rounded-none'
              : 'h-[90vh] max-h-[90vh] w-[95vw] max-w-5xl md:max-h-[85vh]',
          )}
          showCloseButton={false}
          aria-label={t('analytics.title')}
        >
          <div className="flex h-full min-h-0 flex-col">
            <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
              <Icon name="chart-line" className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 truncate text-sm font-medium">{t('analytics.title')}</span>
              <span className="hidden truncate text-xs text-muted-foreground md:inline">
                {t('analytics.description')}
              </span>
              <DialogClose
                className={cn(
                  'ml-auto flex items-center justify-center rounded-lg p-1.5 text-muted-foreground opacity-70 transition-opacity hover:bg-interactive-hover hover:text-foreground hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring',
                  touch && 'min-h-10 min-w-10',
                )}
                aria-label={t('common.close')}
              >
                <Icon name="close" className="size-4" />
              </DialogClose>
            </header>

            <nav
              className="flex shrink-0 gap-1 overflow-x-auto border-b border-border px-2 py-2"
              aria-label={t('analytics.title')}
            >
              {ANALYTICS_TABS.map((item) => {
                const meta = TAB_META[item]
                const active = tab === item
                return (
                  <button
                    key={item}
                    type="button"
                    onClick={() => handleTabChange(item)}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-sm transition-[transform,color] duration-150 active:scale-[0.96]',
                      touch && 'min-h-10',
                      active
                        ? 'bg-interactive-selection text-interactive-selection-foreground'
                        : 'text-muted-foreground hover:bg-interactive-hover hover:text-foreground',
                    )}
                  >
                    <Icon name={meta.icon} className="size-4 shrink-0" />
                    {t(meta.labelKey)}
                  </button>
                )
              })}
            </nav>

            <div className="flex shrink-0 flex-col gap-2 border-b border-border px-3 py-2">
              <div className="flex flex-wrap items-end gap-2">
                <div className="max-w-full overflow-x-auto">
                  <SegmentedControl
                    value={preset}
                    onChange={setPreset}
                    ariaLabel={t('analytics.filter.period')}
                    className={cn(touch && '[&>button]:min-h-10')}
                    options={[
                      { value: '7d', label: t('analytics.preset.7d') },
                      { value: '30d', label: t('analytics.preset.30d') },
                      { value: '90d', label: t('analytics.preset.90d') },
                      { value: 'custom', label: t('analytics.preset.custom') },
                    ]}
                  />
                </div>

                {preset === 'custom' && (
                  <div className="flex flex-wrap items-end gap-2">
                    <div className="flex flex-col gap-1">
                      <span className="text-[0.7rem] text-muted-foreground">
                        {t('analytics.filter.from')}
                      </span>
                      <input
                        type="date"
                        value={customFrom}
                        max={customTo}
                        onChange={(event) => setCustomFrom(event.target.value)}
                        aria-label={t('analytics.filter.from')}
                        className={cn(
                          'rounded-lg border border-input bg-background px-2 text-sm',
                          touch ? 'h-10' : 'h-8',
                        )}
                      />
                    </div>
                    <div className="flex flex-col gap-1">
                      <span className="text-[0.7rem] text-muted-foreground">
                        {t('analytics.filter.to')}
                      </span>
                      <input
                        type="date"
                        value={customTo}
                        min={customFrom}
                        onChange={(event) => setCustomTo(event.target.value)}
                        aria-label={t('analytics.filter.to')}
                        className={cn(
                          'rounded-lg border border-input bg-background px-2 text-sm',
                          touch ? 'h-10' : 'h-8',
                        )}
                      />
                    </div>
                  </div>
                )}

                {showUser && (
                  <FilterSelect
                    label={t('analytics.filter.user')}
                    value={filters.userId}
                    items={userItems}
                    onChange={(value) => setFilters((state) => ({ ...state, userId: value }))}
                    touch={touch}
                  />
                )}
                {showProject && (
                  <FilterSelect
                    label={t('analytics.filter.project')}
                    value={filters.projectId}
                    items={projectItems}
                    onChange={(value) => setFilters((state) => ({ ...state, projectId: value }))}
                    touch={touch}
                  />
                )}
                {showModel && (
                  <FilterSelect
                    label={t('analytics.filter.model')}
                    value={filters.model}
                    items={modelItems}
                    onChange={(value) => setFilters((state) => ({ ...state, model: value }))}
                    touch={touch}
                  />
                )}
                {showAgent && (
                  <FilterSelect
                    label={t('analytics.filter.agent')}
                    value={filters.agent}
                    items={agentItems}
                    onChange={(value) => setFilters((state) => ({ ...state, agent: value }))}
                    touch={touch}
                  />
                )}
              </div>

              <div className="flex flex-wrap items-end gap-2">
                <FilterSelect
                  label={t('analytics.filter.groupBy')}
                  value={groupValue}
                  items={groupItems}
                  onChange={(value) => setGroups((state) => ({ ...state, [tab]: value }))}
                  touch={touch}
                />

                <div className="ml-auto flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void handleExport('csv')}
                    disabled={exportDisabled || exporting !== null}
                    className={cn(
                      'inline-flex items-center gap-1.5 rounded-lg border border-input px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground disabled:opacity-50',
                      touch ? 'min-h-10' : 'h-8',
                    )}
                  >
                    <Icon name="download" className="size-3.5" />
                    {t('analytics.export.csv')}
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleExport('json')}
                    disabled={exportDisabled || exporting !== null}
                    className={cn(
                      'inline-flex items-center gap-1.5 rounded-lg border border-input px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground disabled:opacity-50',
                      touch ? 'min-h-10' : 'h-8',
                    )}
                  >
                    <Icon name="file-code" className="size-3.5" />
                    {t('analytics.export.json')}
                  </button>
                  <button
                    type="button"
                    onClick={handlePrint}
                    disabled={exportDisabled}
                    className={cn(
                      'inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50',
                      touch ? 'min-h-10' : 'h-8',
                    )}
                  >
                    <Icon name="file-text" className="size-3.5" />
                    {t('analytics.print')}
                  </button>
                </div>
              </div>
            </div>

            <div className="flex-1 min-h-0 space-y-3 overflow-y-auto overscroll-contain px-3 py-3">
              {tab === 'usage' && summary && (
                <CardGrid>
                  <StatCard
                    label={t('analytics.summary.cost')}
                    value={formatCostMap(summary.costByCurrency) || '—'}
                  />
                  <StatCard
                    label={t('analytics.summary.tokens')}
                    value={formatTokens(summary.usage.total_tokens ?? 0)}
                  />
                  <StatCard
                    label={t('analytics.summary.requests')}
                    value={formatTokens(summary.usage.requests ?? 0)}
                  />
                  <StatCard
                    label={t('analytics.summary.cacheHit')}
                    value={percent(summary.usage.cache_hit_rate)}
                  />
                </CardGrid>
              )}

              {tab === 'activity' && summary && (
                <CardGrid>
                  <StatCard
                    label={t('analytics.summary.sessions')}
                    value={formatTokens(summary.activity.sessions_created ?? 0)}
                  />
                  <StatCard
                    label={t('analytics.summary.messages')}
                    value={formatTokens(
                      (summary.activity.messages_user ?? 0) +
                        (summary.activity.messages_assistant ?? 0) +
                        (summary.activity.messages_tool ?? 0),
                    )}
                  />
                  <StatCard
                    label={t('analytics.summary.toolCalls')}
                    value={formatTokens(summary.activity.tool_calls ?? 0)}
                  />
                  <StatCard
                    label={t('analytics.summary.errors')}
                    value={formatTokens(summary.activity.errors ?? 0)}
                  />
                </CardGrid>
              )}

              {tab === 'prompt' && totals && (
                <CardGrid>
                  <StatCard
                    label={t('analytics.summary.cacheHit')}
                    value={percent(totals.derived.cache_hit_rate)}
                  />
                  <StatCard
                    label={t('analytics.summary.reasoningShare')}
                    value={percent(totals.derived.reasoning_ratio)}
                  />
                  <StatCard
                    label={t('analytics.summary.tps')}
                    value={formatTps(totals.derived.output_tps ?? 0)}
                  />
                  <StatCard
                    label={t('analytics.summary.tokens')}
                    value={formatTokens(totals.measures.total_tokens ?? totals.derived.total_tokens ?? 0)}
                  />
                </CardGrid>
              )}

              {summaryForbidden && (tab === 'usage' || tab === 'activity') && (
                <p className="rounded-lg border border-border/70 px-3 py-2 text-xs text-muted-foreground">
                  {t('analytics.summaryForbidden')}
                </p>
              )}

              {forbidden ? (
                <ForbiddenNotice />
              ) : error ? (
                <div className="rounded-xl border border-border/70 px-4 py-6 text-center text-sm">
                  <p className="font-medium text-foreground">{t('analytics.loadError')}</p>
                  <p className="mt-1 break-words text-xs text-muted-foreground">{error}</p>
                  <button
                    type="button"
                    onClick={() => setRetryTick((value) => value + 1)}
                    className={cn(
                      'mt-3 rounded-lg border border-input px-3 text-xs text-muted-foreground hover:bg-interactive-hover hover:text-foreground',
                      touch ? 'min-h-10' : 'h-8',
                    )}
                  >
                    {t('common.refresh')}
                  </button>
                </div>
              ) : (
                <AnalyticsTable
                  key={`${tab}:${period.from}:${period.to}:${groupValue}:${filters.userId}:${filters.projectId}:${filters.model}:${filters.agent}`}
                  report={visibleReport}
                  loading={loading}
                  touch={touch}
                />
              )}

              <p className="text-[0.65rem] text-muted-foreground">{t('analytics.utcNote')}</p>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {printSnapshot &&
        createPortal(<AnalyticsPrintReport snapshot={printSnapshot} />, document.body)}
    </>
  )
}
