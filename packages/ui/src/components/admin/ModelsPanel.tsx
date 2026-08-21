import { useCallback, useEffect, useRef, useState } from 'react'
import { synthApi, type ModelGroup, type ModelInfo } from '@/lib/api/synthApi'
import { Icon } from '@/components/icon/Icon'
import { cn } from '@/lib/utils'
import { useI18n } from '@/lib/i18n'
import { ProviderIcon } from './ProviderIcon'

type EditingPrices = Record<string, {
  inputPrice: string
  outputPrice: string
  cacheReadPrice: string
  cacheWritePrice: string
}>

export const ModelsPanel = () => {
  const { t } = useI18n()
  const [groups, setGroups] = useState<ModelGroup[]>([])
  const [loading, setLoading] = useState(true)
  const [filterProvider, setFilterProvider] = useState('')
  const [onlyEnabled, setOnlyEnabled] = useState(false)
  const [fetching, setFetching] = useState<string | null>(null)
  const [fetchMsg, setFetchMsg] = useState('')
  const [fetchError, setFetchError] = useState('')
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())
  const [editingPrices, setEditingPrices] = useState<EditingPrices>({})
  const [showAddForm, setShowAddForm] = useState(false)
  const [addProvider, setAddProvider] = useState('')
  const [addName, setAddName] = useState('')
  const [addCtx, setAddCtx] = useState('')
  const [addInPrice, setAddInPrice] = useState('')
  const [addOutPrice, setAddOutPrice] = useState('')
  const [addSaving, setAddSaving] = useState(false)
  const [addError, setAddError] = useState('')
  const debounceTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await synthApi.getModels()
      setGroups(data || [])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const handleFetch = async (providerName?: string) => {
    setFetching(providerName || 'all')
    setFetchMsg('')
    setFetchError('')
    try {
      const url = providerName
        ? `/api/v2/models/fetch?provider=${encodeURIComponent(providerName)}`
        : '/api/v2/models/fetch'
      const data = await synthApi.fetchJSON<{ fetched: number; new: number; enriched: number; errors?: string[] }>(
        url, { method: 'POST' },
      )
        const parts = [t('admin.models.syncResult', { fetched: data.fetched })]
        if (data.new > 0) parts.push(t('admin.models.newModels', { count: data.new }))
        if (data.enriched > 0) parts.push(t('admin.models.enriched', { count: data.enriched }))
      setFetchMsg(parts.join(', '))
      if (data.errors?.length) {
        setFetchError(data.errors.join('; '))
      }
      await load()
    } catch (err) {
        setFetchError(err instanceof Error ? err.message : t('admin.models.syncError'))
    } finally {
      setFetching(null)
    }
  }

  const saveModel = async (modelId: string, updates: Partial<ModelInfo>) => {
    try {
      await synthApi.fetchJSON('/api/v2/models', {
        method: 'POST',
        body: JSON.stringify({ id: modelId, ...updates }),
      })
    } catch { /* ignore */ }
  }

  const toggleEnabled = async (model: ModelInfo) => {
    // Оптимистичное обновление
    setGroups((prev) =>
      prev.map((g) => ({
        ...g,
        models: g.models.map((m) => (m.id === model.id ? { ...m, enabled: !m.enabled } : m)),
      }))
    )
    await saveModel(model.id, { enabled: !model.enabled } as ModelInfo)
  }

  const setAsDefault = async (model: ModelInfo) => {
    // Оптимистичное обновление
    setGroups((prev) =>
      prev.map((g) => {
        if (g.provider.name !== model.provider) return g
        return {
          ...g,
          provider: { ...g.provider, defaultModel: model.name },
          models: g.models.map((m) => ({ ...m, isDefault: m.id === model.id })),
        }
      })
    )
    try {
      await synthApi.fetchJSON('/api/v2/models', {
        method: 'POST',
        body: JSON.stringify({ id: model.id, provider: model.provider, set_as_default: true }),
      })
    } catch { /* ignore */ }
  }

  const startEditPrice = (model: ModelInfo) => {
    setEditingPrices((prev) => ({
      ...prev,
      [model.id]: {
        inputPrice: String(model.input_price ?? ''),
        outputPrice: String(model.output_price ?? ''),
        cacheReadPrice: String(model.cache_read_price ?? ''),
        cacheWritePrice: String(model.cache_write_price ?? ''),
      },
    }))
  }

  const updatePriceField = (modelId: string, field: string, value: string) => {
    setEditingPrices((prev) => ({
      ...prev,
      [modelId]: { ...prev[modelId], [field]: value },
    }))

    // Debounce save
    const timerKey = `${modelId}:${field}`
    const existing = debounceTimers.current.get(timerKey)
    if (existing) clearTimeout(existing)

    const timer = setTimeout(async () => {
      const num = value === '' ? undefined : parseFloat(value)
      if (value !== '' && isNaN(num!)) return

      try {
        const fieldMap: Record<string, string> = {
          inputPrice: 'input_price',
          outputPrice: 'output_price',
          cacheReadPrice: 'cache_read_price',
          cacheWritePrice: 'cache_write_price',
        }
        await synthApi.fetchJSON('/api/v2/models', {
          method: 'POST',
          body: JSON.stringify({ id: modelId, [fieldMap[field]]: num }),
        })
        // Refresh model data
        setGroups((prev) =>
          prev.map((g) => ({
            ...g,
            models: g.models.map((m) =>
              m.id === modelId ? { ...m, [fieldMap[field]]: num } : m,
            ),
          }))
        )
      } catch { /* ignore */ }
    }, 500)

    debounceTimers.current.set(timerKey, timer)
  }

  const handleContextEdit = async (model: ModelInfo, value: string) => {
    const num = value === '' ? undefined : parseInt(value, 10)
    if (value !== '' && (isNaN(num!) || num! < 0)) return

    // Ручной ввод (не пустое значение) — всегда помечаем как manual, чтобы
    // следующий fetch не затёр значение провайдером. Очистка поля — сброс к
    // unknown (context_window: null удаляет сохранённое окно на бэкенде).
    const contextWindow = num !== undefined ? num : null
    const contextSource = num !== undefined ? 'manual' : 'unknown'

    setGroups((prev) =>
      prev.map((g) => ({
        ...g,
        models: g.models.map((m) =>
          m.id === model.id ? { ...m, context_window: contextWindow ?? undefined, context_source: contextSource } : m,
        ),
      }))
    )

    try {
      await synthApi.fetchJSON('/api/v2/models', {
        method: 'POST',
        body: JSON.stringify({
          id: model.id,
          context_window: contextWindow,
          context_source: contextSource,
        }),
      })
    } catch { /* ignore */ }
  }

  const handleDelete = async (modelId: string) => {
    if (!confirm(t('admin.models.confirmDelete', { id: modelId }))) return
    try {
      await synthApi.fetchJSON(`/api/v2/models/${encodeURIComponent(modelId)}`, { method: 'DELETE' })
      await load()
    } catch { /* ignore */ }
  }

  const handleAddModel = async () => {
    setAddError('')
    if (!addProvider || !addName.trim()) {
      setAddError(t('admin.models.selectProviderAndName'))
      return
    }
    setAddSaving(true)
    try {
      const fullId = `${addProvider}/${addName.trim()}`
      const body: Record<string, unknown> = {
        id: fullId,
        name: addName.trim(),
        provider: addProvider,
        enabled: true,
      }
      if (addCtx !== '') {
        const w = parseInt(addCtx, 10)
        if (!isNaN(w)) { body.context_window = w; body.context_source = 'manual' }
      }
      if (addInPrice !== '') { const v = parseFloat(addInPrice); if (!isNaN(v)) body.input_price = v }
      if (addOutPrice !== '') { const v = parseFloat(addOutPrice); if (!isNaN(v)) body.output_price = v }

      await synthApi.fetchJSON('/api/v2/models', {
        method: 'POST',
        body: JSON.stringify(body),
      })
      setShowAddForm(false)
      setAddName('')
      setAddCtx('')
      setAddInPrice('')
      setAddOutPrice('')
      await load()
    } catch (err) {
      setAddError(err instanceof Error ? err.message : t('admin.models.createError'))
    } finally {
      setAddSaving(false)
    }
  }

  const toggleGroup = (providerName: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(providerName)) next.delete(providerName)
      else next.add(providerName)
      return next
    })
  }

  const allProviders = groups.map((g) => g.provider.name)
  const totalModels = groups.reduce((sum, g) => sum + g.models.length, 0)
  const filteredGroups = groups
    .filter((g) => !filterProvider || g.provider.name === filterProvider)
    .map((g) => ({
      ...g,
      models: g.models.filter((m) => !onlyEnabled || m.enabled),
    }))
    .filter((g) => g.models.length > 0)
  const visibleCount = filteredGroups.reduce((sum, g) => sum + g.models.length, 0)

  // Проверяем, есть ли отключённые провайдеры
  const enabledProviders = groups.filter((g) => g.models.length > 0)

  const formatPrice = (price?: number) => {
    if (price === undefined || price === null) return ''
    return `$${price.toFixed(2)}`
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="shrink-0 space-y-4">
      {/* Заголовок */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold">{t('admin.models.title')}</h3>
          <p className="text-muted-foreground text-sm">
            {t('admin.models.count', { visible: visibleCount, total: totalModels, providers: enabledProviders.length })}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => handleFetch()}
            disabled={fetching !== null}
            className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
          >
            <Icon name="refresh" className={cn("size-3.5", fetching === 'all' && "animate-spin")} />
            {t('admin.models.syncAll')}
          </button>
        </div>
      </div>

      {/* Сообщения */}
      {fetchMsg && (
        <div className="bg-emerald-50 dark:bg-emerald-950 border border-emerald-200 dark:border-emerald-800 rounded-lg p-3 text-sm text-emerald-700 dark:text-emerald-300">
          {fetchMsg}
        </div>
      )}
      {fetchError && (
        <div className="bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 rounded-lg p-3 text-sm text-red-700 dark:text-red-300">
          {fetchError}
        </div>
      )}

      {/* Фильтры */}
      <div className="flex gap-3 items-center flex-wrap">
        <select
          value={filterProvider}
          onChange={(e) => setFilterProvider(e.target.value)}
          className="px-3 py-1.5 rounded-lg border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        >
          <option value="">{t('admin.models.allProviders')}</option>
          {allProviders.map((p) => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <input
            type="checkbox"
            checked={onlyEnabled}
            onChange={(e) => setOnlyEnabled(e.target.checked)}
          />
          {t('admin.models.onlyEnabled')}
        </label>
        <button
          onClick={() => setShowAddForm(true)}
          className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs border border-dashed hover:border-solid hover:bg-muted transition-colors"
        >
          <Icon name="add" className="size-3.5" />
          {t('admin.models.add')}
        </button>
      </div>

      {/* Форма добавления */}
      {showAddForm && (
        <div className="bg-background rounded-lg border p-4 space-y-3">
          <div className="text-sm font-medium">{t('admin.models.addManual')}</div>
          {addError && (
            <div className="bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 rounded p-2 text-xs text-red-700 dark:text-red-300">
              {addError}
            </div>
          )}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div>
              <label className="text-[11px] text-muted-foreground block mb-1">{t('admin.models.provider')}</label>
              <select
                value={addProvider}
                onChange={(e) => setAddProvider(e.target.value)}
                className="w-full px-2 py-1.5 rounded border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              >
                <option value="">—</option>
                {allProviders.map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-[11px] text-muted-foreground block mb-1">{t('admin.models.name')}</label>
              <input
                type="text"
                value={addName}
                onChange={(e) => setAddName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleAddModel()}
                placeholder="gpt-4o"
                className="w-full px-2 py-1.5 rounded border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            <div>
              <label className="text-[11px] text-muted-foreground block mb-1">{t('admin.models.contextK')}</label>
              <input
                type="number"
                value={addCtx}
                onChange={(e) => setAddCtx(e.target.value)}
                placeholder="128"
                step="1"
                min="0"
                className="w-full px-2 py-1.5 rounded border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            <div className="grid grid-cols-2 gap-1">
              <div>
                <label className="text-[11px] text-muted-foreground block mb-1">{t('admin.models.priceIn')}</label>
                <input
                  type="number"
                  value={addInPrice}
                  onChange={(e) => setAddInPrice(e.target.value)}
                  placeholder="0.15"
                  step="0.01"
                  min="0"
                  className="w-full px-2 py-1.5 rounded border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
              <div>
                <label className="text-[11px] text-muted-foreground block mb-1">{t('admin.models.priceOut')}</label>
                <input
                  type="number"
                  value={addOutPrice}
                  onChange={(e) => setAddOutPrice(e.target.value)}
                  placeholder="0.60"
                  step="0.01"
                  min="0"
                  className="w-full px-2 py-1.5 rounded border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
            </div>
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleAddModel}
              disabled={addSaving}
              className="px-3 py-1.5 rounded-lg text-xs bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {addSaving ? '...' : t('admin.models.addButton')}
            </button>
            <button
              onClick={() => { setShowAddForm(false); setAddError('') }}
              className="px-3 py-1.5 rounded-lg text-xs text-muted-foreground hover:bg-muted"
            >
              {t('admin.models.cancel')}
            </button>
          </div>
        </div>
      )}

      </div>

      {/* Содержимое */}
      <div className="flex-1 overflow-y-auto min-h-0 overscroll-behavior-contain mt-4">
      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="bg-background rounded-lg border p-4 animate-pulse">
              <div className="h-4 bg-muted rounded w-32 mb-3" />
              <div className="space-y-2">
                {[1, 2].map((j) => (
                  <div key={j} className="h-3 bg-muted rounded w-64" />
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : filteredGroups.length === 0 ? (
        <div className="bg-background rounded-xl border p-8 text-center text-muted-foreground">
          {t('admin.models.empty')}
        </div>
      ) : (
        <div className="space-y-2">
          {filteredGroups.map((group) => {
            const isCollapsed = collapsedGroups.has(group.provider.name)
            return (
              <div key={group.provider.name} className="bg-background rounded-lg border">
                {/* Заголовок группы */}
                <div className="flex items-center gap-3 px-4 py-3 border-b">
                  <button
                    onClick={() => toggleGroup(group.provider.name)}
                    className="p-0.5 hover:bg-muted rounded transition-colors"
                  >
                    <Icon
                      name="arrow-right-s"
                      className={cn("size-4 text-muted-foreground transition-transform", !isCollapsed && "rotate-90")}
                    />
                  </button>
                  <ProviderIcon
                    icon={group.provider.icon}
                    size={18}
                    className="shrink-0"
                  />
                  <span className="font-medium text-sm">{group.provider.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {t('admin.models.modelsCount', { count: group.models.length })}
                  </span>
                  {group.provider.defaultModel && (
                    <span className="text-xs text-muted-foreground ml-auto mr-2">
                      {t('admin.models.defaultModel', { model: group.provider.defaultModel })}
                    </span>
                  )}
                  <button
                    onClick={() => handleFetch(group.provider.name)}
                    disabled={fetching !== null}
                    className="flex items-center gap-1 px-2 py-1 rounded text-xs bg-muted hover:bg-muted/70 disabled:opacity-50"
                  >
                    <Icon
                      name="refresh"
                      className={cn("size-3", fetching === group.provider.name && "animate-spin")}
                    />
                    {t('admin.models.refresh')}
                  </button>
                </div>

                {/* Строки моделей */}
                {!isCollapsed && (
                  <div>
                    {/* Шапка таблицы */}
                    <div className="grid grid-cols-[1fr_80px_140px_70px_40px_32px] gap-2 px-4 py-2 text-[11px] font-medium text-muted-foreground border-b">
                      <span className="pl-1">{t('admin.models.model')}</span>
                      <span className="text-center">{t('admin.models.context')}</span>
                      <span className="text-center">{t('admin.models.prices')}</span>
                      <span className="text-center">{t('admin.models.enabledCol')}</span>
                      <span className="text-center">{t('admin.models.defaultCol')}</span>
                      <span />
                    </div>

                    {group.models.length === 0 ? (
                      <div className="px-4 py-3 text-sm text-muted-foreground">
                        {t('admin.models.filterEmpty')}
                      </div>
                    ) : (
                      group.models.map((model) => {
                        const editing = editingPrices[model.id]
                        return (
                          <div
                            key={model.id}
                            className="grid grid-cols-[1fr_80px_140px_70px_40px_32px] gap-2 px-4 py-2 items-center border-b border-dashed last:border-b-0 hover:bg-muted/30 text-sm"
                          >
                            {/* Название модели + иконка */}
                            <div className="flex items-center gap-2 min-w-0">
                              <ProviderIcon
                                icon={group.provider.icon}
                                size={14}
                                className="shrink-0"
                              />
                              <div className="min-w-0">
                                <span className={cn("font-medium truncate block", !model.enabled && "opacity-50")}>
                                  {model.name}
                                </span>
                              </div>
                            </div>

                            {/* Контекстное окно */}
                            <div className="text-center">
                              <input
                                type="number"
                                min="0"
                                step="1000"
                                value={model.context_window ?? ''}
                                onChange={(e) => handleContextEdit(model, e.target.value)}
                                onFocus={(e) => e.target.select()}
                                className={cn(
                                  "w-full text-center bg-transparent border rounded px-1 py-0.5 text-xs focus:outline-none focus:ring-1 focus:ring-ring tabular-nums",
                                  model.context_source === 'reference' && "italic text-muted-foreground italic",
                                )}
                                title={model.context_window
                                  ? t('admin.models.contextTitle', {
                                      k: (model.context_window / 1000).toFixed(0),
                                      source: model.context_source === 'reference'
                                        ? t('admin.models.contextRef')
                                        : model.context_source === 'api'
                                          ? t('admin.models.contextApi')
                                          : model.context_source === 'manual'
                                            ? t('admin.models.contextManual')
                                            : '',
                                    })
                                  : ''}
                              />
                            </div>

                            {/* Цены */}
                            <div className="grid grid-cols-2 gap-0.5 text-[10px] tabular-nums">
                              <input
                                type="number"
                                min="0"
                                step="0.01"
                                placeholder="in"
                                value={editing?.inputPrice ?? formatPrice(model.input_price)}
                                onChange={(e) => updatePriceField(model.id, 'inputPrice', e.target.value)}
                                onFocus={() => !editing && startEditPrice(model)}
                                className="w-full text-center bg-transparent border rounded px-0.5 py-0.5 text-[10px] focus:outline-none focus:ring-1 focus:ring-ring"
                                title={t('admin.models.priceInTitle')}
                              />
                              <input
                                type="number"
                                min="0"
                                step="0.01"
                                placeholder="out"
                                value={editing?.outputPrice ?? formatPrice(model.output_price)}
                                onChange={(e) => updatePriceField(model.id, 'outputPrice', e.target.value)}
                                onFocus={() => !editing && startEditPrice(model)}
                                className="w-full text-center bg-transparent border rounded px-0.5 py-0.5 text-[10px] focus:outline-none focus:ring-1 focus:ring-ring"
                                title={t('admin.models.priceOutTitle')}
                              />
                              <input
                                type="number"
                                min="0"
                                step="0.01"
                                placeholder="cr"
                                value={editing?.cacheReadPrice ?? formatPrice(model.cache_read_price)}
                                onChange={(e) => updatePriceField(model.id, 'cacheReadPrice', e.target.value)}
                                onFocus={() => !editing && startEditPrice(model)}
                                className="w-full text-center bg-transparent border rounded px-0.5 py-0.5 text-[10px] focus:outline-none focus:ring-1 focus:ring-ring"
                                title={t('admin.models.priceCrTitle')}
                              />
                              <input
                                type="number"
                                min="0"
                                step="0.01"
                                placeholder="cw"
                                value={editing?.cacheWritePrice ?? formatPrice(model.cache_write_price)}
                                onChange={(e) => updatePriceField(model.id, 'cacheWritePrice', e.target.value)}
                                onFocus={() => !editing && startEditPrice(model)}
                                className="w-full text-center bg-transparent border rounded px-0.5 py-0.5 text-[10px] focus:outline-none focus:ring-1 focus:ring-ring"
                                title={t('admin.models.priceCwTitle')}
                              />
                            </div>

                            {/* Включено / Выключено */}
                            <div className="flex justify-center">
                              <button
                                onClick={() => toggleEnabled(model)}
                                className={cn(
                                  "px-2 py-0.5 rounded text-[10px] font-medium transition-colors cursor-pointer",
                                  model.enabled
                                    ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-200 dark:bg-emerald-900 dark:text-emerald-300'
                                    : 'bg-slate-100 text-slate-500 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-400'
                                )}
                                title={model.enabled ? t('admin.models.disableModel') : t('admin.models.enableModel')}
                              >
                                {model.enabled ? t('common.on').toUpperCase() : t('common.off').toUpperCase()}
                              </button>
                            </div>

                            {/* По умолчанию */}
                            <div className="flex justify-center">
                              <button
                                onClick={() => setAsDefault(model)}
                                className={cn(
                                  "p-0.5 rounded transition-colors",
                                  model.isDefault
                                    ? 'text-amber-500 hover:text-amber-600'
                                    : 'text-muted-foreground/30 hover:text-amber-400'
                                )}
                                title={model.isDefault ? t('admin.models.defaultModelTitle') : t('admin.models.makeDefault')}
                              >
                                <Icon name={model.isDefault ? 'star-fill' : 'star'} className="size-3.5" />
                              </button>
                            </div>

                            {/* Удалить */}
                            <div className="flex justify-center">
                              <button
                                onClick={() => handleDelete(model.id)}
                                className="p-0.5 rounded text-muted-foreground/40 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950"
                                title={t('admin.models.deleteModel')}
                              >
                                <Icon name="delete-bin" className="size-3.5" />
                              </button>
                            </div>
                          </div>
                        )
                      })
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
      </div>
    </div>
  )
}
