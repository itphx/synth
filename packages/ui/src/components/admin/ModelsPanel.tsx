import { useCallback, useEffect, useRef, useState } from 'react'
import { synthApi, type ModelGroup, type ModelInfo } from '@/lib/api/synthApi'
import { Icon } from '@/components/icon/Icon'
import { cn } from '@/lib/utils'
import { useI18n } from '@/lib/i18n'
import { confirm } from '@/lib/confirm'
import { SelectContent, SelectItem } from '@/components/ui/select'
import { Button } from '../ui/button'
import { ProviderIcon } from './ProviderIcon'
import { CurrencyPicker } from './CurrencyPicker'
import { formatMoney, type Currency } from '@/lib/currency'
import {
  NumberField,
  SettingsActions,
  SettingsPanel,
  SettingsSection,
  SelectField,
  TextField,
  ToggleField,
} from '../ui/settings'

type EditingPrices = Record<string, {
  inputPrice: string
  outputPrice: string
  cacheReadPrice: string
  cacheWritePrice: string
}>

export const ModelsPanel = () => {
  const { t, locale } = useI18n()
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

  // Debounce-таймеры сохранения цен: чистим при размонтировании, чтобы
  // отложенный колбэк не дёрнул setState/API после ухода панели.
  useEffect(() => {
    const timers = debounceTimers.current
    return () => {
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
    }
  }, [])

  const handleFetch = async (providerName?: string) => {
    setFetching(providerName || 'all')
    setFetchMsg('')
    setFetchError('')
    try {
      const data = await synthApi.fetchModels(providerName)
      const parts = [t('admin.models.syncResult', { fetched: data.fetched })]
      if (data.new > 0) parts.push(t('admin.models.newModels', { count: data.new }))
      if (data.enriched > 0) parts.push(t('admin.models.enriched', { count: data.enriched }))
      if (data.priced) parts.push(t('admin.models.priced', { count: data.priced }))
      if (data.limited) parts.push(t('admin.models.limited', { count: data.limited }))
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
      await synthApi.saveModel({ id: modelId, ...updates })
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

  const setCurrency = async (model: ModelInfo, currency: Currency) => {
    // Оптимистичное обновление
    setGroups((prev) =>
      prev.map((g) => ({
        ...g,
        models: g.models.map((m) => (m.id === model.id ? { ...m, currency } : m)),
      }))
    )
    await saveModel(model.id, { currency })
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
      await synthApi.saveModel({ id: model.id, provider: model.provider, set_as_default: true })
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
        await synthApi.saveModel({ id: modelId, [fieldMap[field]!]: num })
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
      await synthApi.saveModel({
        id: model.id,
        context_window: contextWindow,
        context_source: contextSource,
      })
    } catch { /* ignore */ }
  }

  const handleDelete = async (modelId: string) => {
    if (!(await confirm({ title: t('admin.models.confirmDelete', { id: modelId }), variant: 'danger' }))) return
    try {
      await synthApi.deleteModel(modelId)
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

      await synthApi.saveModel(body)
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

  const enabledProviders = groups.filter((g) => g.models.length > 0)

  const formatPrice = (price?: number, currency?: string) => {
    if (price === undefined || price === null) return ''
    return formatMoney(price, currency, { locale })
  }

  return (
    <SettingsPanel
      title={t('admin.models.title')}
      meta={t('admin.models.count', { visible: visibleCount, total: totalModels, providers: enabledProviders.length })}
      actions={
        <Button
          onClick={() => handleFetch()}
          disabled={fetching !== null}
        >
          <Icon name="refresh" className={cn('size-3.5', fetching === 'all' && 'animate-spin')} />
          {t('admin.models.syncAll')}
        </Button>
      }
    >
      {/* Сообщения */}
      {fetchMsg && (
        <div className="bg-status-success/10 border border-status-success/30 rounded-lg p-3 text-sm text-status-success min-w-0 break-words">
          {fetchMsg}
        </div>
      )}
      {fetchError && (
        <div className="bg-status-error/10 border border-status-error/30 rounded-lg p-3 text-sm text-status-error min-w-0 break-words">
          {fetchError}
        </div>
      )}

      {/* Фильтры */}
      <SettingsSection>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <SelectField
            label={t('admin.models.allProviders')}
            value={filterProvider}
            onValueChange={setFilterProvider}
            ariaLabel={t('admin.models.allProviders')}
          >
            <SelectContent>
              <SelectItem value="">{t('admin.models.allProviders')}</SelectItem>
              {allProviders.map((p) => (
                <SelectItem key={p} value={p}>{p}</SelectItem>
              ))}
            </SelectContent>
          </SelectField>
          <ToggleField
            label={t('admin.models.onlyEnabled')}
            enabled={onlyEnabled}
            onToggle={() => setOnlyEnabled((v) => !v)}
          />
        </div>
        <Button
          variant="outline"
          onClick={() => setShowAddForm(true)}
          className="border-dashed hover:border-solid hover:bg-muted"
        >
          <Icon name="add" className="size-3.5" />
          {t('admin.models.add')}
        </Button>
      </SettingsSection>

      {/* Форма добавления */}
      {showAddForm && (
        <SettingsSection title={t('admin.models.addManual')}>
          {addError && (
            <div className="bg-status-error/10 border border-status-error/30 rounded p-2 text-xs text-status-error min-w-0 break-words">
              {addError}
            </div>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <SelectField
              label={t('admin.models.provider')}
              value={addProvider}
              onValueChange={setAddProvider}
              ariaLabel={t('admin.models.provider')}
            >
              <SelectContent>
                <SelectItem value="">—</SelectItem>
                {allProviders.map((p) => (
                  <SelectItem key={p} value={p}>{p}</SelectItem>
                ))}
              </SelectContent>
            </SelectField>
            <TextField
              label={t('admin.models.name')}
              value={addName}
              onChange={(e) => setAddName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleAddModel()}
              placeholder="gpt-4o"
            />
            <NumberField
              label={t('admin.models.contextK')}
              value={addCtx}
              onChange={(e) => setAddCtx(e.target.value)}
              placeholder="128"
              step={1}
              min={0}
              className="sm:w-full"
            />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
              <NumberField
                label={t('admin.models.priceIn')}
                value={addInPrice}
                onChange={(e) => setAddInPrice(e.target.value)}
                placeholder="0.15"
                step={0.01}
                min={0}
                className="sm:w-full"
              />
              <NumberField
                label={t('admin.models.priceOut')}
                value={addOutPrice}
                onChange={(e) => setAddOutPrice(e.target.value)}
                placeholder="0.60"
                step={0.01}
                min={0}
                className="sm:w-full"
              />
            </div>
          </div>
          <SettingsActions
            onSave={handleAddModel}
            onCancel={() => { setShowAddForm(false); setAddError('') }}
            saving={addSaving}
            saveLabel={t('admin.models.addButton')}
            cancelLabel={t('admin.models.cancel')}
            saveTestId="model-add-save"
            cancelTestId="model-add-cancel"
          />
        </SettingsSection>
      )}

      {/* Содержимое */}
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
        <SettingsSection>
          <p className="py-4 text-center text-muted-foreground">{t('admin.models.empty')}</p>
        </SettingsSection>
      ) : (
        <div className="space-y-2">
          {filteredGroups.map((group) => {
            const isCollapsed = collapsedGroups.has(group.provider.name)
            return (
              <SettingsSection key={group.provider.name} className="p-0 overflow-hidden">
                <div className="min-w-0">
                  {/* Заголовок группы */}
                  <div className="flex flex-wrap items-center gap-3 px-4 py-3 border-b min-w-0">
                    <button
                      onClick={() => toggleGroup(group.provider.name)}
                      className="p-0.5 hover:bg-muted rounded transition-colors shrink-0"
                      aria-label={group.provider.name}
                    >
                      <Icon
                        name="arrow-right-s"
                        className={cn('size-4 text-muted-foreground transition-transform', !isCollapsed && 'rotate-90')}
                      />
                    </button>
                    <ProviderIcon
                      icon={group.provider.icon}
                      size={18}
                      className="shrink-0"
                    />
                    <span className="font-medium text-sm min-w-0 break-words">{group.provider.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {t('admin.models.modelsCount', { count: group.models.length })}
                    </span>
                    {group.provider.defaultModel && (
                      <span className="text-xs text-muted-foreground sm:ml-auto sm:mr-2 min-w-0 break-words">
                        {t('admin.models.defaultModel', { model: group.provider.defaultModel })}
                      </span>
                    )}
                    <button
                      onClick={() => handleFetch(group.provider.name)}
                      disabled={fetching !== null}
                      className="flex items-center gap-1 px-2 py-1 rounded text-xs bg-muted hover:bg-interactive-hover disabled:opacity-50 shrink-0"
                    >
                      <Icon
                        name="refresh"
                        className={cn('size-3', fetching === group.provider.name && 'animate-spin')}
                      />
                      {t('admin.models.refresh')}
                    </button>
                  </div>

                  {/* Строки моделей */}
                  {!isCollapsed && (
                    <div className="overflow-x-auto">
                      <div className="min-w-[35rem]">
                        {/* Шапка таблицы */}
                        <div className="flex gap-2 px-4 py-2 text-[0.6875rem] font-medium text-muted-foreground border-b">
                          <span className="flex-1 min-w-0 pl-1">{t('admin.models.model')}</span>
                          <span className="w-20 shrink-0 text-center">{t('admin.models.context')}</span>
                          <span className="w-[8.75rem] shrink-0 text-center">{t('admin.models.prices')}</span>
                          <span className="w-[4.375rem] shrink-0 text-center">{t('admin.models.enabledCol')}</span>
                          <span className="w-10 shrink-0 text-center">{t('admin.models.defaultCol')}</span>
                          <span className="w-8 shrink-0" />
                        </div>

                        {group.models.length === 0 ? (
                          <div className="px-4 py-3 text-sm text-muted-foreground">
                            {t('admin.models.filterEmpty')}
                          </div>
                        ) : (
                          group.models.map((model) => {
                            const editing = editingPrices[model.id]
                            // Валюта цен: модель → провайдер → USD.
                            const currency = model.currency ?? group.provider.currency
                            return (
                              <div
                                key={model.id}
                                className="flex gap-2 px-4 py-2 items-center border-b border-dashed last:border-b-0 bg-surface-inset hover:bg-interactive-hover text-sm"
                              >
                                {/* Название модели + иконка */}
                                <div className="flex flex-1 min-w-0 items-center gap-2">
                                  <ProviderIcon
                                    icon={group.provider.icon}
                                    size={14}
                                    className="shrink-0"
                                  />
                                  <div className="min-w-0">
                                    <span className={cn('font-medium truncate block', !model.enabled && 'opacity-50')}>
                                      {model.name}
                                    </span>
                                  </div>
                                </div>

                                {/* Контекстное окно */}
                                <div className="w-20 shrink-0 text-center">
                                  <input
                                    type="number"
                                    min="0"
                                    step="1000"
                                    value={model.context_window ?? ''}
                                    onChange={(e) => handleContextEdit(model, e.target.value)}
                                    onFocus={(e) => e.target.select()}
                                    className={cn(
                                      'w-full text-center bg-background border rounded px-1.5 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-ring tabular-nums',
                                      model.context_source === 'reference' && 'italic text-muted-foreground',
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
                                <div className="w-[8.75rem] shrink-0 flex items-center gap-1 text-[0.625rem] tabular-nums">
                                  <CurrencyPicker
                                    value={currency}
                                    onChange={(next) => setCurrency(model, next)}
                                  />
                                  <div className="flex flex-1 flex-wrap gap-1">
                                    <input
                                      type="number"
                                      min="0"
                                      step="0.01"
                                      placeholder="in"
                                      value={editing?.inputPrice ?? model.input_price ?? ''}
                                      onChange={(e) => updatePriceField(model.id, 'inputPrice', e.target.value)}
                                      onFocus={() => !editing && startEditPrice(model)}
                                      className="w-[calc(50%-0.125rem)] text-center bg-background border rounded px-1 py-1 text-[0.625rem] focus:outline-none focus:ring-1 focus:ring-ring"
                                      title={formatPrice(model.input_price, currency) || t('admin.models.priceInTitle')}
                                    />
                                    <input
                                      type="number"
                                      min="0"
                                      step="0.01"
                                      placeholder="out"
                                      value={editing?.outputPrice ?? model.output_price ?? ''}
                                      onChange={(e) => updatePriceField(model.id, 'outputPrice', e.target.value)}
                                      onFocus={() => !editing && startEditPrice(model)}
                                      className="w-[calc(50%-0.125rem)] text-center bg-background border rounded px-1 py-1 text-[0.625rem] focus:outline-none focus:ring-1 focus:ring-ring"
                                      title={formatPrice(model.output_price, currency) || t('admin.models.priceOutTitle')}
                                    />
                                    <input
                                      type="number"
                                      min="0"
                                      step="0.01"
                                      placeholder="cr"
                                      value={editing?.cacheReadPrice ?? model.cache_read_price ?? ''}
                                      onChange={(e) => updatePriceField(model.id, 'cacheReadPrice', e.target.value)}
                                      onFocus={() => !editing && startEditPrice(model)}
                                      className="w-[calc(50%-0.125rem)] text-center bg-background border rounded px-1 py-1 text-[0.625rem] focus:outline-none focus:ring-1 focus:ring-ring"
                                      title={formatPrice(model.cache_read_price, currency) || t('admin.models.priceCrTitle')}
                                    />
                                    <input
                                      type="number"
                                      min="0"
                                      step="0.01"
                                      placeholder="cw"
                                      value={editing?.cacheWritePrice ?? model.cache_write_price ?? ''}
                                      onChange={(e) => updatePriceField(model.id, 'cacheWritePrice', e.target.value)}
                                      onFocus={() => !editing && startEditPrice(model)}
                                      className="w-[calc(50%-0.125rem)] text-center bg-background border rounded px-1 py-1 text-[0.625rem] focus:outline-none focus:ring-1 focus:ring-ring"
                                      title={formatPrice(model.cache_write_price, currency) || t('admin.models.priceCwTitle')}
                                    />
                                  </div>
                                </div>

                                {/* Включено / Выключено */}
                                <div className="w-[4.375rem] shrink-0 flex justify-center">
                                  <button
                                    onClick={() => toggleEnabled(model)}
                                    className={cn(
                                      'px-2 py-0.5 rounded text-[0.625rem] font-medium transition-colors cursor-pointer',
                                      model.enabled
                                        ? 'bg-status-success/10 text-status-success hover:bg-status-success/20'
                                        : 'bg-secondary text-muted-foreground hover:bg-interactive-hover'
                                    )}
                                    title={model.enabled ? t('admin.models.disableModel') : t('admin.models.enableModel')}
                                  >
                                    {model.enabled ? t('common.on').toUpperCase() : t('common.off').toUpperCase()}
                                  </button>
                                </div>

                                {/* По умолчанию */}
                                <div className="w-10 shrink-0 flex justify-center">
                                  <button
                                    onClick={() => setAsDefault(model)}
                                    className={cn(
                                      'p-0.5 rounded transition-colors',
                                      model.isDefault
                                        ? 'text-status-warning hover:text-status-warning/80'
                                        : 'text-muted-foreground/30 hover:text-status-warning/70'
                                    )}
                                    title={model.isDefault ? t('admin.models.defaultModelTitle') : t('admin.models.makeDefault')}
                                  >
                                    <Icon name={model.isDefault ? 'star-fill' : 'star'} className="size-3.5" />
                                  </button>
                                </div>

                                {/* Удалить */}
                                <div className="w-8 shrink-0 flex justify-center">
                                  <Button
                                    variant="ghost"
                                    onClick={() => handleDelete(model.id)}
                                    className="p-0.5 text-muted-foreground/40 hover:bg-status-error/10 hover:text-status-error"
                                    title={t('admin.models.deleteModel')}
                                  >
                                    <Icon name="delete-bin" className="size-3.5" />
                                  </Button>
                                </div>
                              </div>
                            )
                          })
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </SettingsSection>
            )
          })}
        </div>
      )}
    </SettingsPanel>
  )
}
