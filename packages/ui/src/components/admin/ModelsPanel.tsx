import { useEffect, useState } from 'react'
import { synthApi, type ModelInfo } from '@/lib/api/synthApi'
import { Icon } from '@/components/icon/Icon'
import { cn } from '@/lib/utils'

export const ModelsPanel = () => {
  const [models, setModels] = useState<ModelInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [filterProvider, setFilterProvider] = useState('')
  const [onlyEnabled, setOnlyEnabled] = useState(false)
  const [fetching, setFetching] = useState(false)
  const [fetchMsg, setFetchMsg] = useState('')
  const [providers, setProviders] = useState<string[]>([])

  const load = async () => {
    setLoading(true)
    try {
      const data = await synthApi.getModels()
      setModels(data.models || [])
      setProviders([...new Set(data.models.map(m => m.provider))])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const handleFetch = async () => {
    setFetching(true)
    setFetchMsg('')
    try {
      const data = await synthApi.fetchJSON<{ fetched: number; models: string[] }>(
        '/api/v2/models/fetch', { method: 'POST' },
      )
      setFetchMsg(`Синхронизировано ${data.fetched} моделей`)
      await load()
    } catch (err) {
      setFetchMsg(err instanceof Error ? err.message : 'Ошибка синхронизации')
    } finally {
      setFetching(false)
    }
  }

  const handleDelete = async (id: string) => {
    if (!confirm(`Удалить модель «${id}»?`)) return
    try {
      await synthApi.fetchJSON(`/api/v2/models/${encodeURIComponent(id)}`, { method: 'DELETE' })
      await load()
    } catch { /* ignore */ }
  }

  const filtered = models
    .filter(m => !filterProvider || m.provider === filterProvider)
    .filter(m => !onlyEnabled || m.enabled)

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold">Модели</h3>
          <p className="text-muted-foreground text-sm">{filtered.length} / {models.length} моделей</p>
        </div>
        <button
          onClick={handleFetch}
          disabled={fetching}
          className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
        >
          <Icon name="refresh" className={cn("size-3.5", fetching && "animate-spin")} />
          Синхронизировать
        </button>
      </div>

      {fetchMsg && (
        <div className="bg-emerald-50 dark:bg-emerald-950 border border-emerald-200 dark:border-emerald-800 rounded-lg p-3 text-sm text-emerald-700 dark:text-emerald-300">
          {fetchMsg}
        </div>
      )}

      <div className="flex gap-3">
        <select
          value={filterProvider} onChange={(e) => setFilterProvider(e.target.value)}
          className="px-3 py-1.5 rounded-lg border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        >
          <option value="">Все провайдеры</option>
          {providers.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <input type="checkbox" checked={onlyEnabled} onChange={(e) => setOnlyEnabled(e.target.checked)} />
          Только включённые
        </label>
      </div>

      {loading ? (
        <div className="space-y-2">{[1,2,3].map(i => <div key={i} className="bg-background rounded-lg border p-3 animate-pulse"><div className="h-4 bg-muted rounded w-48" /></div>)}</div>
      ) : filtered.length === 0 ? (
        <div className="bg-background rounded-xl border p-8 text-center text-muted-foreground">
          Нет моделей. Нажмите «Синхронизировать» для загрузки.
        </div>
      ) : (
        <div className="space-y-1">
          <div className="grid grid-cols-[1fr_100px_120px_80px_60px] gap-3 px-4 py-2 text-xs font-medium text-muted-foreground border-b">
            <span>Название</span>
            <span>Провайдер</span>
            <span>Контекст</span>
            <span>Статус</span>
            <span />
          </div>
          {filtered.map((m) => (
            <div key={`${m.provider}/${m.name}`} className="grid grid-cols-[1fr_100px_120px_80px_60px] gap-3 px-4 py-2.5 items-center bg-background rounded-lg border text-sm">
              <span className="font-medium truncate">{m.name}</span>
              <span className="text-muted-foreground text-xs">{m.provider}</span>
              <span className="text-muted-foreground text-xs">{m.context_window ? `${(m.context_window / 1000).toFixed(0)}K` : '—'}</span>
              <span>
                <span className={cn(
                  "px-1.5 py-0.5 rounded text-[10px] font-medium",
                  m.enabled ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300' : 'bg-slate-100 text-slate-600'
                )}>
                  {m.enabled ? 'ВКЛ' : 'ВЫКЛ'}
                </span>
              </span>
              <button
                onClick={() => handleDelete(`${m.provider}/${m.name}`)}
                className="p-1 rounded text-muted-foreground hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950 justify-self-end"
              >
                <Icon name="delete-bin" className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
