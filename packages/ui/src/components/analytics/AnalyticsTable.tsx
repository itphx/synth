import { useState } from 'react'

import type { AnalyticsReport } from '@itphx/synth-shared/types'
import { Icon } from '@/components/icon/Icon'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import {
  analyticsCellValue,
  analyticsColumnLabelKey,
  analyticsTotalValue,
  buildAnalyticsColumns,
  computeAnalyticsTotals,
  formatAnalyticsCell,
  sortAnalyticsRows,
  type AnalyticsColumn,
  type AnalyticsSortDirection,
} from './analytics-model'

interface AnalyticsTableProps {
  report: AnalyticsReport | null
  loading?: boolean
  /** Крупные тач-таргеты в заголовках (ADR-044). */
  touch?: boolean
}

interface SortState {
  key: string
  direction: AnalyticsSortDirection
}

/**
 * Таблица отчёта ADR-102: сортировка по клику по заголовку (оси — по строке,
 * меры/стоимость — по значению) и итоговая строка из сумм сырых счётчиков.
 */
export function AnalyticsTable({ report, loading, touch }: AnalyticsTableProps) {
  const { t } = useI18n()
  const [sort, setSort] = useState<SortState | null>(null)

  if (!report || report.rows.length === 0) {
    return (
      <div className="flex min-h-32 items-center justify-center rounded-xl border border-border/70 p-6 text-sm text-muted-foreground">
        {loading ? t('common.loading') : t('analytics.empty')}
      </div>
    )
  }

  const columns = buildAnalyticsColumns(report)
  const activeColumn = sort ? columns.find((column) => column.key === sort.key) : undefined
  const rows = activeColumn ? sortAnalyticsRows(report.rows, activeColumn, sort!.direction) : report.rows
  const totals = computeAnalyticsTotals(report)
  const showTotal = totals !== null && report.rows.length > 1

  const toggleSort = (column: AnalyticsColumn) => {
    setSort((current) => {
      if (!current || current.key !== column.key) return { key: column.key, direction: 'asc' }
      if (current.direction === 'asc') return { key: column.key, direction: 'desc' }
      return null
    })
  }

  const headerLabel = (column: AnalyticsColumn): string => {
    const key = analyticsColumnLabelKey(column)
    return column.kind === 'cost' ? t(key, { currency: column.currency }) : t(key)
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-border/70" data-testid="analytics-table">
      <table className="w-full min-w-full border-collapse text-xs">
        <thead>
          <tr className="border-b border-border/70 bg-interactive/40">
            {columns.map((column) => {
              const isActive = sort?.key === column.key
              const ariaSort = isActive ? (sort!.direction === 'asc' ? 'ascending' : 'descending') : 'none'
              return (
                <th
                  key={column.key}
                  scope="col"
                  aria-sort={ariaSort}
                  className={cn(
                    'whitespace-nowrap px-3 py-2 font-medium text-muted-foreground',
                    column.kind === 'axis' ? 'text-left' : 'text-right',
                  )}
                >
                  <button
                    type="button"
                    onClick={() => toggleSort(column)}
                    className={cn(
                      'inline-flex max-w-full items-center gap-1 rounded px-1 transition-colors hover:text-foreground',
                      touch ? 'min-h-10' : 'min-h-6',
                      isActive && 'text-foreground',
                    )}
                    aria-label={t('analytics.sortBy', { column: headerLabel(column) })}
                  >
                    <span className="truncate">{headerLabel(column)}</span>
                    {isActive && (
                      <Icon
                        name={sort!.direction === 'asc' ? 'arrow-up' : 'arrow-down'}
                        className="size-3 shrink-0"
                      />
                    )}
                  </button>
                </th>
              )
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr
              key={rowIndex}
              className="border-b border-border/40 last:border-b-0 hover:bg-interactive/30"
            >
              {columns.map((column) => (
                <td
                  key={column.key}
                  className={cn(
                    'whitespace-nowrap px-3 py-1.5 tabular-nums',
                    column.kind === 'axis'
                      ? 'text-left text-foreground'
                      : 'text-right text-muted-foreground',
                  )}
                >
                  {formatAnalyticsCell(column, analyticsCellValue(row, column))}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        {showTotal && (
          <tfoot>
            <tr className="border-t border-border bg-interactive/30 font-medium">
              {columns.map((column, columnIndex) => {
                const total = analyticsTotalValue(totals!, column)
                const label = column.kind === 'axis' && columnIndex === 0 ? t('analytics.total') : null
                return (
                  <td
                    key={column.key}
                    className={cn(
                      'whitespace-nowrap px-3 py-2 tabular-nums',
                      column.kind === 'axis' ? 'text-left' : 'text-right',
                    )}
                  >
                    {label ?? (total === undefined ? '' : formatAnalyticsCell(column, total))}
                  </td>
                )
              })}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  )
}
