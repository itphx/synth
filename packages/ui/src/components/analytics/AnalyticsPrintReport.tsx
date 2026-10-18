import {
  ANALYTICS_DERIVED_MEASURES,
  ANALYTICS_MEASURES_BY_FAMILY,
} from '@itphx/synth-shared/types'
import type { AnalyticsReport, AnalyticsSummary } from '@itphx/synth-shared/types'
import { useI18n } from '@/lib/i18n'
import { formatCost } from '@/lib/formatStats'
import {
  analyticsCellValue,
  analyticsColumnLabelKey,
  analyticsTotalValue,
  buildAnalyticsColumns,
  computeAnalyticsTotals,
  formatAnalyticsCell,
  type AnalyticsColumn,
} from './analytics-model'
import type { AnalyticsTab } from './analytics-types'
import './analytics-print.css'

export interface AnalyticsPrintFilter {
  label: string
  value: string
}

/** Снимок данных на момент печати (окно не зависит от последующих перезагрузок). */
export interface AnalyticsPrintSnapshot {
  tab: AnalyticsTab
  from: string
  to: string
  filters: AnalyticsPrintFilter[]
  report: AnalyticsReport | null
  summary: AnalyticsSummary | null
  forbidden: boolean
}

const TAB_TITLE_KEY: Record<AnalyticsTab, string> = {
  usage: 'analytics.tab.usage',
  activity: 'analytics.tab.activity',
  decision: 'analytics.tab.decision',
  prompt: 'analytics.tab.prompt',
}

/** Сырые меры сводки семейства (для печатной таблицы «Сводка»). */
function summaryMeasures(tab: AnalyticsTab, summary: AnalyticsSummary): Array<[string, number, boolean]> {
  if (tab === 'usage') {
    const raw = ANALYTICS_MEASURES_BY_FAMILY.usage.map(
      (key) => [key, summary.usage[key] ?? 0, false] as [string, number, boolean],
    )
    const derived = ANALYTICS_DERIVED_MEASURES.map(
      (key) => [key, summary.usage[key] ?? 0, true] as [string, number, boolean],
    )
    return [...raw, ...derived]
  }
  if (tab === 'activity') {
    return ANALYTICS_MEASURES_BY_FAMILY.activity.map(
      (key) => [key, summary.activity[key] ?? 0, false] as [string, number, boolean],
    )
  }
  return ANALYTICS_MEASURES_BY_FAMILY.decision.map(
    (key) => [key, summary.decision[key] ?? 0, false] as [string, number, boolean],
  )
}

function measureColumn(key: string, derived: boolean): AnalyticsColumn {
  return derived
    ? { key: `derived:${key}`, kind: 'derived', measure: key }
    : { key: `measure:${key}`, kind: 'measure', measure: key }
}

/**
 * Печатная версия отчёта (браузерная печать → PDF, PROP-102 §5). Рендерится в
 * портал `document.body`; вне `@media print` скрыта (`analytics-print.css`).
 */
export function AnalyticsPrintReport({ snapshot }: { snapshot: AnalyticsPrintSnapshot }) {
  const { t } = useI18n()
  const title = t(TAB_TITLE_KEY[snapshot.tab])
  const report = snapshot.report
  const columns = report ? buildAnalyticsColumns(report) : []
  const totals = computeAnalyticsTotals(report)

  return (
    <div className="analytics-print-root" data-testid="analytics-print-root">
      <h1>{t('analytics.print.title')}</h1>
      <div className="analytics-print-meta">
        <div>
          {t('analytics.print.period')}: {snapshot.from} — {snapshot.to} (UTC)
        </div>
        <div>
          {t('analytics.print.generatedAt')}: {new Date().toISOString()}
        </div>
        <div>
          {t('analytics.print.filters')}:{' '}
          {snapshot.filters.length > 0
            ? snapshot.filters.map((filter) => `${filter.label}: ${filter.value}`).join('; ')
            : t('analytics.print.noFilters')}
        </div>
      </div>

      <h2>{title}</h2>

      {snapshot.forbidden && <p>{t('analytics.forbidden')}</p>}

      {!snapshot.forbidden && snapshot.summary && snapshot.tab !== 'prompt' && (
        <>
          <h2>{t('analytics.print.summary')}</h2>
          <table>
            <tbody>
              {summaryMeasures(snapshot.tab, snapshot.summary).map(([key, value, derived]) => (
                <tr key={key}>
                  <td>{t(`analytics.measure.${key}`)}</td>
                  <td>{formatAnalyticsCell(measureColumn(key, derived), value)}</td>
                </tr>
              ))}
              {Object.entries(snapshot.summary.costByCurrency ?? {}).map(([currency, value]) => (
                <tr key={`cost:${currency}`}>
                  <td>{t('analytics.column.cost', { currency })}</td>
                  <td>{formatCost(value, currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {!snapshot.forbidden && report && report.rows.length > 0 && (
        <table>
          <thead>
            <tr>
              {columns.map((column) => (
                <th key={column.key} scope="col">
                  {column.kind === 'cost'
                    ? t(analyticsColumnLabelKey(column), { currency: column.currency })
                    : t(analyticsColumnLabelKey(column))}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {report.rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {columns.map((column) => (
                  <td key={column.key}>
                    {formatAnalyticsCell(column, analyticsCellValue(row, column))}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
          {totals && report.rows.length > 1 && (
            <tfoot>
              <tr className="analytics-print-total">
                {columns.map((column, columnIndex) => {
                  const total = analyticsTotalValue(totals, column)
                  const label =
                    column.kind === 'axis' && columnIndex === 0 ? t('analytics.total') : ''
                  return (
                    <td key={column.key}>
                      {label || (total === undefined ? '' : formatAnalyticsCell(column, total))}
                    </td>
                  )
                })}
              </tr>
            </tfoot>
          )}
        </table>
      )}

      {!snapshot.forbidden && (!report || report.rows.length === 0) && !snapshot.summary && (
        <p>{t('analytics.empty')}</p>
      )}
    </div>
  )
}
