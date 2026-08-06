import { useEffect, useState, useCallback } from 'react'
import { synthApi } from '@/lib/api/synthApi'
import { Icon } from '@/components/icon/Icon'
import { cn } from '@/lib/utils'
import { useI18n } from '@/lib/i18n'
import { detectLogLevel, colorForLevel, stripAnsi } from './logFormat'

const TAIL_OPTIONS = [100, 200, 500, 1000]
const AUTO_REFRESH_MS = 5000

interface LogFilePanelProps {
  logName: string
  title: string
  description: string
}

/** Универсальная панель просмотра лог-файла (core/ui/backend): фильтры, хвост, авто-обновление. */
export const LogFilePanel = ({ logName, title, description }: LogFilePanelProps) => {
  const { t } = useI18n()
  const [tail, setTail] = useState(200)
  const [search, setSearch] = useState('')
  const [autoRefresh, setAutoRefresh] = useState(false)
  const [lines, setLines] = useState<string[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await synthApi.getLogs(logName, {
        tail,
        search: search.trim() || undefined,
      })
      setLines(data.lines)
      setTotal(data.total)
    } catch (e) {
      setError(e instanceof Error ? e.message : t('logs.error'))
      setLines([])
      setTotal(0)
    } finally {
      setLoading(false)
    }
  }, [logName, tail, search, t])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    if (!autoRefresh) return
    const id = setInterval(load, AUTO_REFRESH_MS)
    return () => clearInterval(id)
  }, [autoRefresh, load])

  return (
    <div className="space-y-4 max-w-5xl">
      <div>
        <h3 className="text-lg font-semibold">{title}</h3>
        <p className="text-muted-foreground text-sm mt-1">{description}</p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          {t('logs.tail')}
          <select
            value={tail}
            onChange={(e) => setTail(Number(e.target.value))}
            className="bg-interactive-selection border border-border rounded-lg px-2.5 py-1.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          >
            {TAIL_OPTIONS.map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        </label>

        <div className="relative flex-1 min-w-[160px]">
          <Icon name="search" className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('logs.search')}
            className="w-full rounded-lg bg-interactive-selection border border-border pl-8 pr-3 py-1.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>

        <button
          onClick={load}
          disabled={loading}
          className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium text-foreground bg-interactive-selection hover:bg-interactive-hover transition-colors disabled:opacity-50"
          title={t('logs.refresh')}
        >
          <Icon name="refresh" className={cn('size-4', loading && 'animate-spin')} />
          {t('logs.refresh')}
        </button>

        <label className="flex items-center gap-1.5 cursor-pointer select-none text-sm text-muted-foreground">
          <input
            type="checkbox"
            checked={autoRefresh}
            onChange={(e) => setAutoRefresh(e.target.checked)}
            className="rounded"
          />
          {t('logs.autoRefresh')}
        </label>

        <span className="ml-auto text-xs text-muted-foreground tabular-nums">{total}</span>
      </div>

      {error && (
        <div className="p-3 rounded-lg bg-destructive/10 text-destructive text-sm">{error}</div>
      )}

      {loading && !error ? (
        <div className="bg-background rounded-xl border p-5 animate-pulse space-y-1.5">
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="h-4 bg-muted rounded w-full" />
          ))}
        </div>
      ) : lines.length === 0 ? (
        <div className="bg-background rounded-xl border p-8 text-center text-muted-foreground text-sm">
          {t('logs.empty')}
        </div>
      ) : (
        <pre className="bg-background rounded-xl border p-4 overflow-auto text-xs leading-relaxed max-h-[60vh] font-mono">
          {lines.map((raw, idx) => {
            const level = detectLogLevel(raw)
            return (
              <div key={`${idx}-${raw.slice(0, 32)}`} className="flex gap-2 whitespace-pre-wrap break-all">
                <span className="shrink-0 text-muted-foreground/50 tabular-nums select-none w-10 text-right">
                  {total - lines.length + idx + 1}
                </span>
                {level && (
                  <span className={cn('shrink-0 rounded px-1 py-px text-[10px] font-medium h-fit mt-0.5', colorForLevel(level))}>
                    {level}
                  </span>
                )}
                <span className="text-foreground">{stripAnsi(raw)}</span>
              </div>
            )
          })}
        </pre>
      )}
    </div>
  )
}
