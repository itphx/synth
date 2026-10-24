import { useCallback, useEffect, useMemo, useState } from 'react'

import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { formatDateTime } from '@/lib/formatDate'
import { Button } from '../ui/button'
import { Icon } from '../icon/Icon'
import { SelectContent, SelectItem } from '../ui/select'
import { InfoField, SettingsPanel, SettingsSection, SelectField, TextField } from '../ui/settings'
import {
  synthApi,
  type MemoryFact,
  type MemoryFactList,
  type MemoryFactListParams,
  type MemoryFactStatus,
  type MemoryFactStatusFilter,
  type MemoryIndex,
  type MemoryIndexList,
  type MemoryIndexState,
  type MemoryReadiness,
  type MemoryStatus,
} from '@/lib/api/synthApi'

/**
 * ADR-107 / PROP-047: админ-раздел «Память» — **read-only** портал плагина
 * памяти: состояние провайдера, факты (с провенансом и версиями) и индексы
 * для поиска.
 *
 * Раздел только читает: мутаций (создание/пересборка индекса, отзыв факта)
 * в этой волне нет — правда чтения на сервере, UI лишь показывает данные.
 *
 * Плагин памяти может быть не установлен: тогда портал отвечает 503, а
 * раздел объясняет это понятным текстом (`settings.memory.unavailable`).
 */

/** Общий стиль бейджа статуса (как в соседних админ-разделах). */
const BADGE = 'shrink-0 rounded px-1.5 py-0.5 text-[0.625rem] font-medium'

/** Готовность портала — закрытый список значений и их цвета. */
const READINESS_VALUES: MemoryReadiness[] = ['ready', 'degraded', 'stale', 'unavailable']

/** Цвет бейджа готовности портала памяти. */
const READINESS_CLASS: Record<string, string> = {
  ready: 'bg-status-success/15 text-status-success',
  degraded: 'bg-status-warning/15 text-status-warning',
  stale: 'bg-status-warning/15 text-status-warning',
  unavailable: 'bg-destructive/15 text-destructive',
}

/** Цвет бейджа статуса факта. */
const FACT_STATUS_CLASS: Record<string, string> = {
  candidate: 'bg-muted text-muted-foreground',
  active: 'bg-status-success/15 text-status-success',
  superseded: 'bg-status-warning/15 text-status-warning',
  retracted: 'bg-destructive/15 text-destructive',
}

/** Цвет бейджа состояния индекса. */
const INDEX_STATE_CLASS: Record<string, string> = {
  building: 'bg-primary/15 text-primary',
  ready: 'bg-status-success/15 text-status-success',
  stale: 'bg-status-warning/15 text-status-warning',
  failed: 'bg-destructive/15 text-destructive',
}

/** Статусы факта — фильтр раздела «Факты». */
const FACT_STATUSES: MemoryFactStatus[] = ['active', 'candidate', 'superseded', 'retracted']

/** Виды факта (PROP-047 §5.2) — фильтр раздела «Факты». */
const FACT_KINDS = ['decision', 'constraint', 'reference', 'preference', 'observation'] as const

/** Состояния индекса — бейдж в таблице индексов. */
const INDEX_STATES: MemoryIndexState[] = ['building', 'ready', 'stale', 'failed']

/** Режимы исполнения провайдера памяти. */
const PROVIDER_MODES = ['inline', 'remote'] as const

/** Значение фильтра «все виды» — пустой фильтр на сервере. */
const ALL_KINDS = 'all'

/** Значение фильтра «все статусы» — сервер так понимает (`status=all`). */
const ALL_STATUSES = 'all'

/** Размер страницы фактов. */
const PAGE_LIMIT = 50

/** Функция перевода UI-словаря. */
type Translate = (
  key: string,
  params?: Record<string, string | number | boolean | null | undefined>,
) => string

/**
 * Подпись значения из закрытого списка: известные значения переводятся,
 * неизвестные (новый вид факта на сервере) показываются как есть — не ключ i18n.
 */
function label(t: Translate, known: readonly string[], prefix: string, value: string): string {
  return known.includes(value) ? t(`${prefix}.${value}`) : value
}

/** Статус HTTP-ошибки (503 — сервис памяти не сконфигурирован). */
const statusOf = (err: unknown): number | undefined =>
  typeof (err as { status?: unknown })?.status === 'number'
    ? (err as { status: number }).status
    : undefined

/** Уверенность факта: два знака после запятой. */
function formatConfidence(confidence: number): string {
  if (!Number.isFinite(confidence)) return '—'
  return confidence.toFixed(2)
}

export function MemorySettings() {
  const { t, locale } = useI18n()

  const [status, setStatus] = useState<MemoryStatus | null>(null)
  const [statusLoading, setStatusLoading] = useState(true)
  const [statusError, setStatusError] = useState<string | null>(null)

  const [facts, setFacts] = useState<MemoryFactList | null>(null)
  const [factsLoading, setFactsLoading] = useState(true)
  const [factsError, setFactsError] = useState<string | null>(null)

  const [indexes, setIndexes] = useState<MemoryIndexList | null>(null)
  const [indexesLoading, setIndexesLoading] = useState(true)
  const [indexesError, setIndexesError] = useState<string | null>(null)

  const [refreshing, setRefreshing] = useState(false)

  // Фильтры фактов: поле ввода и применённые значения — разные состояния.
  const [queryInput, setQueryInput] = useState('')
  const [query, setQuery] = useState('')
  const [factStatus, setFactStatus] = useState<MemoryFactStatusFilter>('active')
  const [factKind, setFactKind] = useState<string>(ALL_KINDS)
  const [offset, setOffset] = useState(0)

  // Детали выбранного факта (`GET /memory/facts/:id`).
  const [detail, setDetail] = useState<MemoryFact | null>(null)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)

  /** 503 — сервис памяти не сконфигурирован: портал недоступен. */
  const describeError = useCallback(
    (err: unknown, fallback: string): string =>
      statusOf(err) === 503 ? t('settings.memory.unavailable') : fallback,
    [t],
  )

  const loadStatus = useCallback(async () => {
    setStatusLoading(true)
    setStatusError(null)
    try {
      setStatus(await synthApi.getMemoryStatus())
    } catch (err) {
      setStatusError(
        describeError(
          err,
          t('settings.memory.status.error', {
            error: err instanceof Error ? err.message : t('common.error'),
          }),
        ),
      )
    } finally {
      setStatusLoading(false)
    }
  }, [describeError, t])

  /** Параметры выборки фактов — собираются из применённых фильтров. */
  const factParams = useMemo<MemoryFactListParams>(
    () => ({
      ...(query ? { query } : {}),
      ...(factKind !== ALL_KINDS ? { kind: factKind } : {}),
      status: factStatus,
      limit: PAGE_LIMIT,
      offset,
    }),
    [query, factKind, factStatus, offset],
  )

  const loadFacts = useCallback(async () => {
    setFactsLoading(true)
    setFactsError(null)
    try {
      setFacts(await synthApi.listMemoryFacts(factParams))
    } catch (err) {
      setFactsError(
        describeError(
          err,
          t('settings.memory.facts.error', {
            error: err instanceof Error ? err.message : t('common.error'),
          }),
        ),
      )
    } finally {
      setFactsLoading(false)
    }
  }, [describeError, factParams, t])

  const loadIndexes = useCallback(async () => {
    setIndexesLoading(true)
    setIndexesError(null)
    try {
      setIndexes(await synthApi.listMemoryIndexes())
    } catch (err) {
      setIndexesError(
        describeError(
          err,
          t('settings.memory.indexes.error', {
            error: err instanceof Error ? err.message : t('common.error'),
          }),
        ),
      )
    } finally {
      setIndexesLoading(false)
    }
  }, [describeError, t])

  useEffect(() => {
    void loadStatus()
  }, [loadStatus])

  useEffect(() => {
    void loadFacts()
  }, [loadFacts])

  useEffect(() => {
    void loadIndexes()
  }, [loadIndexes])

  /** «Обновить» — перезапрос всех трёх срезов портала. */
  const handleRefresh = useCallback(async () => {
    if (refreshing) return
    setRefreshing(true)
    try {
      await Promise.all([loadStatus(), loadFacts(), loadIndexes()])
    } finally {
      setRefreshing(false)
    }
  }, [loadFacts, loadIndexes, loadStatus, refreshing])

  /** Применение поиска по тексту: фильтр меняется — страница возвращается на первую. */
  const applyQuery = useCallback(() => {
    setQuery(queryInput.trim())
    setOffset(0)
  }, [queryInput])

  const handleStatusFilter = useCallback((value: string) => {
    setFactStatus(value as MemoryFactStatusFilter)
    setOffset(0)
  }, [])

  const handleKindFilter = useCallback((value: string) => {
    setFactKind(value)
    setOffset(0)
  }, [])

  const handlePrevPage = useCallback(() => {
    setOffset((current) => Math.max(0, current - PAGE_LIMIT))
  }, [])

  const handleNextPage = useCallback(() => {
    setOffset((current) => current + PAGE_LIMIT)
  }, [])

  /** Детали факта: повторный клик по тому же факту закрывает блок. */
  const handleOpenDetail = useCallback(
    async (id: string) => {
      if (detailId === id) {
        setDetailId(null)
        setDetail(null)
        setDetailError(null)
        return
      }
      setDetailId(id)
      setDetail(null)
      setDetailError(null)
      setDetailLoading(true)
      try {
        setDetail(await synthApi.getMemoryFact(id))
      } catch (err) {
        setDetailError(
          describeError(
            err,
            t('settings.memory.facts.detail.error', {
              error: err instanceof Error ? err.message : t('common.error'),
            }),
          ),
        )
      } finally {
        setDetailLoading(false)
      }
    },
    [describeError, detailId, t],
  )

  const factsItems = facts?.items ?? []
  const factsTotal = facts?.total ?? 0
  const factsFrom = factsItems.length > 0 ? offset + 1 : 0
  const factsTo = offset + factsItems.length
  const hasNextPage = factsItems.length > 0 && offset + factsItems.length < factsTotal

  return (
    <SettingsPanel
      title={t('settings.memory.title')}
      description={t('settings.memory.description')}
    >
      {/* 1. Состояние: провайдер, готовность, счётчики. */}
      <SettingsSection
        id="memory-status"
        title={t('settings.memory.status.title')}
        description={t('settings.memory.status.description')}
        tooltip={t('settings.help.memory.section.memory-status')}
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => void handleRefresh()}
            disabled={refreshing}
            data-testid="memory-refresh"
          >
            <Icon name="refresh" className={cn('size-3.5', refreshing && 'animate-spin')} />
            {refreshing ? t('settings.memory.refreshing') : t('settings.memory.refresh')}
          </Button>
        }
      >
        {statusError && (
          <div
            role="alert"
            data-testid="memory-status-error"
            className="flex flex-wrap items-start justify-between gap-2 rounded-lg bg-destructive/10 p-3 text-sm text-destructive min-w-0"
          >
            <span className="min-w-0 break-words">{statusError}</span>
            <Button
              variant="outline"
              size="sm"
              className="shrink-0"
              onClick={() => void loadStatus()}
              data-testid="memory-status-retry"
            >
              <Icon name="refresh" className="size-3.5" />
              {t('settings.memory.retry')}
            </Button>
          </div>
        )}

        {statusLoading && !status && (
          <div className="py-3 text-center text-xs text-muted-foreground">{t('common.loading')}</div>
        )}

        {status && (
          <>
            <div className="flex flex-wrap items-center gap-1.5 min-w-0" data-testid="memory-badges">
              <span
                data-testid="memory-readiness-badge"
                className={cn(BADGE, READINESS_CLASS[status.readiness])}
              >
                {label(t, READINESS_VALUES, 'settings.memory.readiness', status.readiness)}
              </span>
              <span
                data-testid="memory-provider-badge"
                className={cn(
                  BADGE,
                  status.provider.active
                    ? 'bg-status-success/15 text-status-success'
                    : 'bg-muted text-muted-foreground',
                )}
              >
                {status.provider.active
                  ? t('settings.memory.provider.active')
                  : t('settings.memory.provider.inactive')}
              </span>
            </div>

            <div className="space-y-1.5 min-w-0" data-testid="memory-status-info">
              <InfoField
                label={t('settings.memory.field.readiness')}
                value={label(t, READINESS_VALUES, 'settings.memory.readiness', status.readiness)}
              />
              <InfoField label={t('settings.memory.field.provider')} value={status.provider.id || '—'} mono />
              <InfoField
                label={t('settings.memory.field.providerMode')}
                value={
                  status.provider.mode
                    ? label(t, PROVIDER_MODES, 'settings.memory.provider.mode', status.provider.mode)
                    : t('settings.memory.provider.mode.none')
                }
                mono
              />
              <InfoField
                label={t('settings.memory.field.namespace')}
                value={status.namespace || '—'}
                mono
              />
              <InfoField
                label={t('settings.memory.field.factsTotal')}
                value={String(status.facts.total)}
                mono
              />
              <InfoField
                label={t('settings.memory.field.factsActive')}
                value={String(status.facts.active)}
                mono
              />
              <InfoField
                label={t('settings.memory.field.indexesTotal')}
                value={String(status.indexes.total)}
                mono
              />
              <InfoField
                label={t('settings.memory.field.indexesReady')}
                value={String(status.indexes.ready)}
                mono
              />
              <InfoField
                label={t('settings.memory.field.indexesStale')}
                value={String(status.indexes.stale)}
                mono
              />
              <InfoField
                label={t('settings.memory.field.indexesFailed')}
                value={String(status.indexes.failed)}
                mono
              />
              <InfoField
                label={t('settings.memory.field.indexesBuilding')}
                value={String(status.indexes.building)}
                mono
              />
            </div>
          </>
        )}
      </SettingsSection>

      {/* 2. Факты: фильтры, постраничный список, детали факта. */}
      <SettingsSection
        id="memory-facts"
        title={t('settings.memory.facts.title')}
        description={t('settings.memory.facts.description')}
        tooltip={t('settings.help.memory.section.memory-facts')}
      >
        {factsError && (
          <div
            role="alert"
            data-testid="memory-facts-error"
            className="flex flex-wrap items-start justify-between gap-2 rounded-lg bg-destructive/10 p-3 text-sm text-destructive min-w-0"
          >
            <span className="min-w-0 break-words">{factsError}</span>
            <Button
              variant="outline"
              size="sm"
              className="shrink-0"
              onClick={() => void loadFacts()}
              data-testid="memory-facts-retry"
            >
              <Icon name="refresh" className="size-3.5" />
              {t('settings.memory.retry')}
            </Button>
          </div>
        )}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 min-w-0">
          <div className="sm:col-span-2 flex flex-wrap items-end gap-2 min-w-0">
            <TextField
              label={t('settings.memory.facts.filter.query')}
              placeholder={t('settings.memory.facts.filter.queryPlaceholder')}
              value={queryInput}
              onChange={(event) => setQueryInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  applyQuery()
                }
              }}
              containerClassName="flex-1 min-w-0"
              id="memory-facts-query"
              data-testid="memory-facts-query"
            />
            <Button
              variant="outline"
              onClick={applyQuery}
              disabled={factsLoading}
              data-testid="memory-facts-search"
            >
              <Icon name="search" className="size-3.5" />
              {t('settings.memory.facts.filter.apply')}
            </Button>
          </div>

          <SelectField
            label={t('settings.memory.facts.filter.status')}
            value={factStatus}
            onValueChange={handleStatusFilter}
            ariaLabel={t('settings.memory.facts.filter.status')}
            triggerTestId="memory-facts-status-filter"
            items={[
              { value: ALL_STATUSES, label: t('settings.memory.facts.filter.all') },
              ...FACT_STATUSES.map((value) => ({
                value,
                label: t(`settings.memory.facts.status.${value}`),
              })),
            ]}
          >
            <SelectContent>
              <SelectItem value={ALL_STATUSES}>{t('settings.memory.facts.filter.all')}</SelectItem>
              {FACT_STATUSES.map((value) => (
                <SelectItem key={value} value={value}>
                  {t(`settings.memory.facts.status.${value}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </SelectField>

          <SelectField
            label={t('settings.memory.facts.filter.kind')}
            value={factKind}
            onValueChange={handleKindFilter}
            ariaLabel={t('settings.memory.facts.filter.kind')}
            triggerTestId="memory-facts-kind-filter"
            items={[
              { value: ALL_KINDS, label: t('settings.memory.facts.filter.all') },
              ...FACT_KINDS.map((value) => ({
                value,
                label: t(`settings.memory.facts.kind.${value}`),
              })),
            ]}
          >
            <SelectContent>
              <SelectItem value={ALL_KINDS}>{t('settings.memory.facts.filter.all')}</SelectItem>
              {FACT_KINDS.map((value) => (
                <SelectItem key={value} value={value}>
                  {t(`settings.memory.facts.kind.${value}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </SelectField>
        </div>

        {factsLoading && !facts && (
          <div className="py-3 text-center text-xs text-muted-foreground">{t('common.loading')}</div>
        )}

        {facts && factsItems.length === 0 && (
          <div
            className="flex flex-col items-center gap-1 py-4 text-center text-muted-foreground"
            data-testid="memory-facts-empty"
          >
            <Icon name="lightbulb" className="size-6 opacity-40" />
            <p className="text-xs">{t('settings.memory.facts.empty')}</p>
          </div>
        )}

        {facts && factsItems.length > 0 && (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs" data-testid="memory-facts-table">
                <thead>
                  <tr className="text-left text-muted-foreground">
                    <th className="py-1 pr-2 font-medium">{t('settings.memory.facts.column.text')}</th>
                    <th className="py-1 pr-2 font-medium">{t('settings.memory.facts.column.kind')}</th>
                    <th className="py-1 pr-2 font-medium">{t('settings.memory.facts.column.status')}</th>
                    <th className="py-1 pr-2 font-medium">
                      {t('settings.memory.facts.column.confidence')}
                    </th>
                    <th className="py-1 pr-2 font-medium">
                      {t('settings.memory.facts.column.provenance')}
                    </th>
                    <th className="py-1 font-medium">{t('settings.memory.facts.column.version')}</th>
                  </tr>
                </thead>
                <tbody>
                  {factsItems.map((fact) => (
                    <tr
                      key={fact.id}
                      className="border-t border-border/60 align-top"
                      data-testid={`memory-fact-${fact.id}`}
                    >
                      <td className="max-w-[16rem] py-1 pr-2">
                        <button
                          type="button"
                          className="block max-w-full truncate text-left text-foreground"
                          title={fact.text}
                          onClick={() => void handleOpenDetail(fact.id)}
                          data-testid={`memory-fact-text-${fact.id}`}
                        >
                          {fact.text}
                        </button>
                      </td>
                      <td className="py-1 pr-2 text-muted-foreground">
                        {label(t, FACT_KINDS, 'settings.memory.facts.kind', fact.kind)}
                      </td>
                      <td className="py-1 pr-2">
                        <span
                          data-testid={`memory-fact-status-${fact.id}`}
                          className={cn(BADGE, FACT_STATUS_CLASS[fact.status])}
                        >
                          {label(t, FACT_STATUSES, 'settings.memory.facts.status', fact.status)}
                        </span>
                      </td>
                      <td className="py-1 pr-2 font-mono">{formatConfidence(fact.confidence)}</td>
                      <td className="py-1 pr-2 text-muted-foreground">
                        <span className="block break-words">
                          {fact.provenance.sourceKind} {fact.provenance.sourceId}
                        </span>
                        <span className="block text-muted-foreground">
                          {formatDateTime(fact.provenance.capturedAt, locale)}
                        </span>
                      </td>
                      <td className="py-1 font-mono">{fact.version}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div
              className="flex flex-wrap items-center justify-between gap-2 min-w-0"
              data-testid="memory-facts-pagination"
            >
              <span className="text-xs text-muted-foreground break-words">
                {t('settings.memory.facts.page', {
                  from: factsFrom,
                  to: factsTo,
                  total: factsTotal,
                })}
              </span>
              <div className="flex shrink-0 items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handlePrevPage}
                  disabled={factsLoading || offset <= 0}
                  data-testid="memory-facts-prev"
                >
                  <Icon name="arrow-go-back" className="size-3.5" />
                  {t('settings.memory.facts.prev')}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleNextPage}
                  disabled={factsLoading || !hasNextPage}
                  data-testid="memory-facts-next"
                >
                  {t('settings.memory.facts.next')}
                  <Icon name="arrow-right" className="size-3.5" />
                </Button>
              </div>
            </div>
          </>
        )}

        {detailLoading && (
          <div className="py-2 text-center text-xs text-muted-foreground">{t('common.loading')}</div>
        )}

        {detailError && (
          <div
            role="alert"
            data-testid="memory-fact-detail-error"
            className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive break-words"
          >
            {detailError}
          </div>
        )}

        {detail && (
          <div
            className="space-y-1.5 rounded-lg border border-border/60 bg-surface-inset p-3 min-w-0"
            data-testid="memory-fact-detail"
          >
            <div className="text-xs font-medium text-foreground break-words">
              {t('settings.memory.facts.detail.title')}
            </div>
            <p className="text-xs text-foreground break-words">{detail.text}</p>
            <InfoField
              label={t('settings.memory.facts.detail.capturedAt')}
              value={formatDateTime(detail.provenance.capturedAt, locale)}
            />
            <InfoField
              label={t('settings.memory.facts.detail.updatedAt')}
              value={formatDateTime(detail.updatedAt, locale)}
            />
            {detail.validUntil && (
              <InfoField
                label={t('settings.memory.facts.detail.validUntil')}
                value={formatDateTime(detail.validUntil, locale)}
              />
            )}
            {detail.supersededBy && (
              <InfoField
                label={t('settings.memory.facts.detail.supersededBy')}
                value={detail.supersededBy}
                mono
              />
            )}
            {detail.projectId && (
              <InfoField
                label={t('settings.memory.facts.detail.projectId')}
                value={detail.projectId}
                mono
              />
            )}
            {detail.userId && (
              <InfoField
                label={t('settings.memory.facts.detail.userId')}
                value={detail.userId}
                mono
              />
            )}
          </div>
        )}
      </SettingsSection>

      {/* 3. Индексы: корпуса для поиска. */}
      <SettingsSection
        id="memory-indexes"
        title={t('settings.memory.indexes.title')}
        description={t('settings.memory.indexes.description')}
        tooltip={t('settings.help.memory.section.memory-indexes')}
      >
        {indexesError && (
          <div
            role="alert"
            data-testid="memory-indexes-error"
            className="flex flex-wrap items-start justify-between gap-2 rounded-lg bg-destructive/10 p-3 text-sm text-destructive min-w-0"
          >
            <span className="min-w-0 break-words">{indexesError}</span>
            <Button
              variant="outline"
              size="sm"
              className="shrink-0"
              onClick={() => void loadIndexes()}
              data-testid="memory-indexes-retry"
            >
              <Icon name="refresh" className="size-3.5" />
              {t('settings.memory.retry')}
            </Button>
          </div>
        )}

        {indexesLoading && !indexes && (
          <div className="py-3 text-center text-xs text-muted-foreground">{t('common.loading')}</div>
        )}

        {indexes && indexes.items.length === 0 && (
          <div
            className="flex flex-col items-center gap-1 py-4 text-center text-muted-foreground"
            data-testid="memory-indexes-empty"
          >
            <Icon name="database-2" className="size-6 opacity-40" />
            <p className="text-xs">{t('settings.memory.indexes.empty')}</p>
          </div>
        )}

        {indexes && indexes.items.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs" data-testid="memory-indexes-table">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="py-1 pr-2 font-medium">
                    {t('settings.memory.indexes.column.name')}
                  </th>
                  <th className="py-1 pr-2 font-medium">
                    {t('settings.memory.indexes.column.state')}
                  </th>
                  <th className="py-1 pr-2 font-medium">
                    {t('settings.memory.indexes.column.generation')}
                  </th>
                  <th className="py-1 pr-2 font-medium">
                    {t('settings.memory.indexes.column.embedding')}
                  </th>
                  <th className="py-1 pr-2 font-medium">
                    {t('settings.memory.indexes.column.volume')}
                  </th>
                  <th className="py-1 font-medium">{t('settings.memory.indexes.column.updated')}</th>
                </tr>
              </thead>
              <tbody>
                {indexes.items.map((index: MemoryIndex) => (
                  <tr
                    key={index.id}
                    className="border-t border-border/60 align-top"
                    data-testid={`memory-index-${index.id}`}
                  >
                    <td className="py-1 pr-2 break-words">
                      <span className="block text-foreground">{index.name}</span>
                      <span className="block text-muted-foreground break-words">
                        {index.source.kind}
                        {index.source.filter ? ` · ${index.source.filter}` : ''}
                      </span>
                    </td>
                    <td className="py-1 pr-2">
                      <span
                        data-testid={`memory-index-state-${index.id}`}
                        className={cn(BADGE, INDEX_STATE_CLASS[index.state])}
                      >
                        {label(t, INDEX_STATES, 'settings.memory.indexes.state', index.state)}
                      </span>
                    </td>
                    <td className="py-1 pr-2 font-mono">{index.generation}</td>
                    <td className="py-1 pr-2 font-mono break-words">
                      {index.fingerprint.model} ({index.fingerprint.dimension})
                    </td>
                    <td className="py-1 pr-2 text-muted-foreground">
                      {t('settings.memory.indexes.volume', {
                        documents: index.stats.documents,
                        chunks: index.stats.chunks,
                      })}
                    </td>
                    <td className="py-1 text-muted-foreground">
                      {formatDateTime(index.updatedAt, locale)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {indexes?.items
          .filter((index) => index.state === 'failed' && index.error)
          .map((index) => (
            <p
              key={index.id}
              data-testid={`memory-index-error-${index.id}`}
              className="text-xs text-destructive break-words"
            >
              {t('settings.memory.indexes.error.hint')}: {index.error}
            </p>
          ))}
      </SettingsSection>
    </SettingsPanel>
  )
}
