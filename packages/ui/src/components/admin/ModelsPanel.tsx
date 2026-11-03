import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  synthApi,
  mergeModelGroups,
  type DefaultModelPair,
  type ModelGroup,
  type ModelInfo,
  type ModelsQuery,
} from '@/lib/api/synthApi'
import { Icon } from '@/components/icon/Icon'
import { cn } from '@/lib/utils'
import { useI18n } from '@/lib/i18n'
import { useDevice } from '@/hooks/useDevice'
import { confirm } from '@/lib/confirm'
import { SelectContent, SelectItem } from '@/components/ui/select'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Button } from '../ui/button'
import { ProviderIcon } from './ProviderIcon'
import { CurrencyPicker } from './CurrencyPicker'
import { formatMoney, type Currency } from '@/lib/currency'
import { useProvidersStore } from '@/stores/providersStore'
import {
  NumberField,
  SettingsActions,
  SettingsPanel,
  SettingsSection,
  SelectField,
  TextField,
  ToggleField,
} from '../ui/settings'
import { CompatibilityFields } from './CompatibilityFields'
import {
  buildCompatibilityPayload,
  draftFromCompatibility,
  emptyCompatibilityDraft,
  isCompatibilitySaved,
  type CompatibilityDraft,
} from '@/lib/api/compatibility'

type EditingPrices = Record<string, {
  inputPrice: string
  outputPrice: string
  cacheReadPrice: string
  cacheWritePrice: string
}>

/** Группа крупнее порога стартует свёрнутой — не строим тысячи строк DOM сразу. */
const LARGE_GROUP_THRESHOLD = 50

/** Модальности входа модели — фильтр каталога (ADR-115). */
const MODEL_MODALITIES = ['text', 'image', 'pdf', 'audio', 'video'] as const

/**
 * Оценки высоты строк виртуального списка (px) — до замера ResizeObserver'ом.
 * На телефоне строка модели — карточка (название / контекст+вкл / цены),
 * поэтому она заметно выше табличной строки.
 */
const MODEL_ROW_HEIGHT = 33
const PHONE_MODEL_ROW_HEIGHT = 168
const GROUP_ROW_HEIGHT = 48
const PHONE_GROUP_ROW_HEIGHT = 64
const SPACER_ROW_HEIGHT = 8

type ProviderGroup = ModelGroup['provider']

/** Плоский список для виртуализации: заголовок группы / строка модели / отступ. */
type ModelListItem =
  | { kind: 'group'; key: string; provider: ProviderGroup; shown: number; total: number; collapsed: boolean }
  | { kind: 'model'; key: string; model: ModelInfo; provider: ProviderGroup }
  | { kind: 'spacer'; key: string }

export const ModelsPanel = () => {
  const { t, locale } = useI18n()
  // Телефон (≤768px): таблица моделей не помещается в ширину панели, поэтому
  // строка перестраивается в карточку (ADR-044). Планшет и десктоп —
  // без изменений: те же колонки, тот же порядок, те же ширины.
  const { deviceType } = useDevice()
  const isPhone = deviceType === 'phone'
  // Кэш стора: если модели уже загружены где-то в приложении — показываем сразу,
  // без скелетона, и обновляем в фоне.
  const cachedGroups = useProvidersStore((s) => s.modelGroups)
  const providersList = useProvidersStore((s) => s.providers)
  const allProviders = useMemo(() => providersList.map((p) => p.name), [providersList])
  const [groups, setGroups] = useState<ModelGroup[]>(cachedGroups)
  const [loading, setLoading] = useState(cachedGroups.length === 0)
  const [loadingMore, setLoadingMore] = useState(false)
  // Каталог постраничный: поиск и фильтры — на сервере, в UI держим только
  // страницу (несколько тысяч моделей грузить нельзя).
  const [total, setTotal] = useState(0)
  const [nextOffset, setNextOffset] = useState<number | null>(null)
  const [filterProvider, setFilterProvider] = useState('')
  const [filterModality, setFilterModality] = useState('')
  const [onlyEnabled, setOnlyEnabled] = useState(false)
  const [search, setSearch] = useState('')
  // Последний применённый запрос каталога — для «Показать ещё».
  const queryRef = useRef<ModelsQuery>({})
  const [fetching, setFetching] = useState<string | null>(null)
  const [fetchMsg, setFetchMsg] = useState('')
  const [fetchError, setFetchError] = useState('')
  // Свёрнутость считается прямо в рендере: крупные группы свёрнуты по умолчанию
  // с первого кадра (без эффекта-инициализации), маленькие — раскрыты.
  // `expandedGroups` — явно раскрытые пользователем/фильтром,
  // `collapsedGroups` — явно свёрнутые (для маленьких групп).
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())
  // Список моделей — виртуализированный. Скролл-контейнер — тело панели
  // настроек (ADR-072: один вертикальный скролл), поэтому у таблицы нет
  // собственного `overflow`/`max-h`.
  const tableRef = useRef<HTMLDivElement>(null)
  const virtualListRef = useRef<HTMLDivElement>(null)
  // Скролл-контейнер панели (тело) — его отдаёт `SettingsPanel` через проп.
  const scrollRef = useRef<HTMLElement | null>(null)
  // Смещение виртуального списка относительно тела панели: строки позиционируются
  // от его начала, а не от начала скролл-контейнера.
  const [scrollMargin, setScrollMargin] = useState(0)
  const [defaultModel, setDefaultModel] = useState<DefaultModelPair | null>(null)
  const [defaultsPair, setDefaultsPair] = useState<DefaultModelPair | null>(null)
  const [isOverridden, setIsOverridden] = useState(false)
  const [defaultSaving, setDefaultSaving] = useState(false)
  const [defaultError, setDefaultError] = useState('')
  const [editingPrices, setEditingPrices] = useState<EditingPrices>({})
  const [showAddForm, setShowAddForm] = useState(false)
  const [addProvider, setAddProvider] = useState('')
  const [addName, setAddName] = useState('')
  const [addCtx, setAddCtx] = useState('')
  const [addInPrice, setAddInPrice] = useState('')
  const [addOutPrice, setAddOutPrice] = useState('')
  const [addSaving, setAddSaving] = useState(false)
  const [addError, setAddError] = useState('')
  // Редактируемая модель (null — форма создаёт новую). Форма одна: при
  // редактировании она предзаполняется, provider/name блокируются.
  const [editingModel, setEditingModel] = useState<ModelInfo | null>(null)
  // Слой совместимости: черновик контролов + признак «уже сохранены параметры»
  // (различает «не отправлять поле» и явный сброс `compatibility: null`).
  const [compatibility, setCompatibility] = useState<CompatibilityDraft>(emptyCompatibilityDraft)
  const [hadCompatibility, setHadCompatibility] = useState(false)
  const debounceTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  const loadDefault = useCallback(async () => {
    try {
      // Старое ядро без пары default-model не должно ломать панель моделей.
      const info = await synthApi.getDefaultModel().catch(() => null)
      if (!info) return
      setDefaultModel(info.defaultModel ?? null)
      setDefaultsPair(info.defaults ?? null)
      setIsOverridden(info.isOverridden)
    } catch {
      /* дефолтная пара не критична для списка */
    }
  }, [])

  /** Загрузка страницы каталога (поиск/фильтры — на сервере). */
  const load = useCallback(async (query: ModelsQuery = {}) => {
    // Данные уже в сторе — не закрываем панель скелетоном, обновляем в фоне.
    if (useProvidersStore.getState().modelGroups.length === 0) setLoading(true)
    try {
      const { groups: nextGroups, page } = await synthApi.getModelGroups(query)
      setGroups(nextGroups)
      setTotal(page.total)
      setNextOffset(page.next_offset)
      // Список — страница каталога: выбор модели по нему не проверяем.
      useProvidersStore.getState().applyModelGroups(nextGroups, { authoritative: false })
    } finally {
      setLoading(false)
    }
  }, [])

  /** Догрузка следующей страницы каталога («Показать ещё»). */
  const loadMore = useCallback(async () => {
    if (nextOffset === null || loadingMore) return
    setLoadingMore(true)
    try {
      const { groups: more, page } = await synthApi.getModelGroups({
        ...queryRef.current,
        offset: nextOffset,
      })
      const merged = mergeModelGroups(groups, more)
      setGroups(merged)
      setNextOffset(page.next_offset)
      useProvidersStore.getState().applyModelGroups(merged, { authoritative: false })
    } catch {
      /* страница не загрузилась — курсор остаётся прежним */
    } finally {
      setLoadingMore(false)
    }
  }, [groups, nextOffset, loadingMore])

  /** Текущий запрос каталога: поиск + фильтры (уходят на сервер). */
  const buildQuery = useCallback((): ModelsQuery => {
    const term = search.trim()
    return {
      ...(term ? { search: term } : {}),
      ...(filterProvider ? { provider: filterProvider } : {}),
      ...(filterModality ? { modality: filterModality } : {}),
      ...(onlyEnabled ? { enabled: true } : {}),
    }
  }, [search, filterProvider, filterModality, onlyEnabled])

  // Список провайдеров — для фильтра (в каталоге моделей он неполный).
  useEffect(() => {
    if (useProvidersStore.getState().providers.length === 0) {
      void useProvidersStore.getState().loadProviders()
    }
  }, [])

  useEffect(() => { void loadDefault() }, [loadDefault])

  // Поиск/фильтры → новая страница каталога. Поиск — с задержкой, чтобы не
  // дёргать сервер на каждое нажатие.
  useEffect(() => {
    const query = buildQuery()
    queryRef.current = query
    const timer = setTimeout(() => { void load(query) }, search.trim() ? 300 : 0)
    return () => clearTimeout(timer)
  }, [buildQuery, load, search])

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
      await load(queryRef.current)
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
    const nextGroups = groups.map((g) => ({
      ...g,
      models: g.models.map((m) => (m.id === model.id ? { ...m, enabled: !m.enabled } : m)),
    }))
    setGroups(nextGroups)
    // Селекторы (чат/настройки/роутинг) живут на сторе — обновляем их сразу.
    // Список — страница каталога: выбор модели по нему не проверяем.
    useProvidersStore.getState().applyModelGroups(nextGroups, { authoritative: false })
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

  /** Задать пару «провайдер + модель» уровня инстанса (дефолт новых сессий). */
  const saveDefaultPair = async (next: DefaultModelPair) => {
    const prevPair = defaultModel
    const prevOverridden = isOverridden
    // Оптимистично: звёздочка/пушпин и селекты переключаются сразу.
    setDefaultModel(next)
    setIsOverridden(true)
    setDefaultError('')
    setDefaultSaving(true)
    try {
      await synthApi.setDefaultModel(next)
      await load(queryRef.current)
    } catch (err) {
      setDefaultModel(prevPair)
      setIsOverridden(prevOverridden)
      setDefaultError(err instanceof Error ? err.message : t('admin.models.saveDefaultError'))
    } finally {
      setDefaultSaving(false)
    }
  }

  const enabledModelsOf = (providerName: string): ModelInfo[] =>
    (groups.find((g) => g.provider.name === providerName)?.models ?? []).filter((m) => m.enabled)

  /**
   * Модели провайдера для селекта «модель по умолчанию». Каталог постраничный,
   * поэтому модели нужного провайдера могут не попасть в загруженную страницу —
   * берём их отдельным запросом (только включённые).
   */
  const [pairProviderModels, setPairProviderModels] = useState<ModelInfo[]>([])

  useEffect(() => {
    const provider = defaultModel?.provider || defaultsPair?.provider || ''
    if (!provider) {
      setPairProviderModels([])
      return
    }
    let cancelled = false
    synthApi
      .getModelGroups({ provider, enabled: true, limit: 100 })
      .then(({ page }) => {
        if (!cancelled) setPairProviderModels(page.models)
      })
      .catch(() => {
        if (!cancelled) setPairProviderModels([])
      })
    return () => { cancelled = true }
  }, [defaultModel?.provider, defaultsPair?.provider])

  const handleDefaultProviderChange = async (providerName: string) => {
    // У провайдера нет включённых моделей — сохранять нечего, просто показываем выбор.
    setDefaultModel(providerName ? { provider: providerName, model: '' } : null)
    if (!providerName) return
    try {
      const { page } = await synthApi.getModelGroups({
        provider: providerName,
        enabled: true,
        limit: 100,
      })
      const first = page.models[0]
      if (!first) return
      await saveDefaultPair({ provider: providerName, model: first.name })
    } catch {
      /* провайдер без моделей — выбор остаётся пустым */
    }
  }

  const handleDefaultModelChange = async (modelName: string) => {
    const provider =
      defaultModel?.provider || defaultsPair?.provider || groups[0]?.provider.name || ''
    if (!provider || !modelName) return
    await saveDefaultPair({ provider, model: modelName })
  }

  const handleResetDefaultModel = async () => {
    setDefaultSaving(true)
    setDefaultError('')
    try {
      const res = await synthApi.resetDefaultModel()
      setDefaultModel(res.defaultModel ?? null)
      setDefaultsPair(res.defaults ?? null)
      setIsOverridden(res.isOverridden ?? false)
      await load(queryRef.current)
    } catch (err) {
      setDefaultError(err instanceof Error ? err.message : t('admin.models.saveDefaultError'))
    } finally {
      setDefaultSaving(false)
    }
  }

  const setAsDefault = async (model: ModelInfo) => {
    // Выключенную модель нельзя назначить по умолчанию: новая сессия получила бы
    // недоступную модель. UI-кнопка тоже disabled — это защита от вызова не из UI.
    if (!model.enabled) return
    const prevPair = defaultModel
    const prevOverridden = isOverridden
    // Оптимистичное обновление
    setDefaultModel({ provider: model.provider, model: model.name })
    setIsOverridden(true)
    setDefaultError('')
    setGroups((prev) =>
      prev.map((g) => ({
        ...g,
        models: g.models.map((m) => ({ ...m, isDefault: m.id === model.id })),
      }))
    )
    try {
      await synthApi.setDefaultModel({ provider: model.provider, model: model.name })
      await load(queryRef.current)
    } catch (err) {
      setDefaultModel(prevPair)
      setIsOverridden(prevOverridden)
      setDefaultError(err instanceof Error ? err.message : t('admin.models.saveDefaultError'))
      await load(queryRef.current)
    }
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
      // Пустое поле → явный null: иначе undefined исчезает из JSON, и сервер
      // сохраняет прежнюю цену (очистка не работала).
      const num = value === '' ? null : parseFloat(value)
      if (num !== null && isNaN(num)) return

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
              m.id === modelId ? { ...m, [fieldMap[field]]: num ?? undefined } : m,
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
      await load(queryRef.current)
    } catch { /* ignore */ }
  }

  /** Открыть пустую форму создания модели (сбрасывает режим редактирования). */
  const openAddForm = () => {
    setEditingModel(null)
    setAddProvider('')
    setAddName('')
    setAddCtx('')
    setAddInPrice('')
    setAddOutPrice('')
    setCompatibility(emptyCompatibilityDraft())
    setHadCompatibility(false)
    setAddError('')
    setShowAddForm(true)
  }

  /**
   * Открыть форму для существующей модели (создание/редактирование — одна форма).
   * Значения переносятся как есть, чтобы сохранение без правок не меняло запись.
   */
  const openEditModel = (model: ModelInfo) => {
    setEditingModel(model)
    setAddProvider(model.provider)
    setAddName(model.name)
    setAddCtx(model.context_window !== undefined ? String(model.context_window) : '')
    setAddInPrice(model.input_price !== undefined ? String(model.input_price) : '')
    setAddOutPrice(model.output_price !== undefined ? String(model.output_price) : '')
    setCompatibility(draftFromCompatibility(model.compatibility))
    setHadCompatibility(isCompatibilitySaved(model.compatibility))
    setAddError('')
    setShowAddForm(true)
  }

  const closeAddForm = () => {
    setShowAddForm(false)
    setEditingModel(null)
    setAddError('')
  }

  // Форма живёт над списком: при открытии/смене модели прокручиваем к ней,
  // иначе редактирование строки из глубины списка выглядит как «ничего не произошло».
  useEffect(() => {
    if (!showAddForm) return
    const section = document.querySelector('[data-settings-section="models-add-manual"]')
    ;(section as HTMLElement | null)?.scrollIntoView?.({ block: 'start' })
  }, [showAddForm, editingModel])

  const handleAddModel = async () => {
    setAddError('')
    if (!addProvider || !addName.trim()) {
      setAddError(t('admin.models.selectProviderAndName'))
      return
    }
    setAddSaving(true)
    try {
      const fullId = editingModel?.id ?? `${addProvider}/${addName.trim()}`
      const body: Record<string, unknown> = {
        id: fullId,
        name: addName.trim(),
        provider: addProvider,
        // Редактирование не должно включать выключенную модель: сохраняем статус.
        enabled: editingModel ? editingModel.enabled : true,
      }
      // При редактировании отправляем контекст/цены только если их изменили:
      // иначе неизменная форма переписала бы источник контекста (`reference` → `manual`).
      const ctxChanged = !editingModel
        || addCtx !== (editingModel.context_window !== undefined ? String(editingModel.context_window) : '')
      if (addCtx !== '' && ctxChanged) {
        const w = parseInt(addCtx, 10)
        if (!isNaN(w)) { body.context_window = w; body.context_source = 'manual' }
      }
      const inChanged = !editingModel
        || addInPrice !== (editingModel.input_price !== undefined ? String(editingModel.input_price) : '')
      if (addInPrice !== '' && inChanged) { const v = parseFloat(addInPrice); if (!isNaN(v)) body.input_price = v }
      const outChanged = !editingModel
        || addOutPrice !== (editingModel.output_price !== undefined ? String(editingModel.output_price) : '')
      if (addOutPrice !== '' && outChanged) { const v = parseFloat(addOutPrice); if (!isNaN(v)) body.output_price = v }

      const compatibilityPayload = buildCompatibilityPayload(compatibility, hadCompatibility)
      if (compatibilityPayload !== undefined) body.compatibility = compatibilityPayload

      await synthApi.saveModel(body)
      setShowAddForm(false)
      setEditingModel(null)
      setAddName('')
      setAddCtx('')
      setAddInPrice('')
      setAddOutPrice('')
      await load(queryRef.current)
    } catch (err) {
      setAddError(err instanceof Error ? err.message : t('admin.models.createError'))
    } finally {
      setAddSaving(false)
    }
  }

  /** Переключить пользовательский выбор группы; состояние приходит из рендера. */
  const toggleGroup = (providerName: string, isCollapsed: boolean) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev)
      if (isCollapsed) next.delete(providerName)
      else next.add(providerName)
      return next
    })
    setExpandedGroups((prev) => {
      const next = new Set(prev)
      if (isCollapsed) next.add(providerName)
      else next.delete(providerName)
      return next
    })
  }

  const expandGroup = (providerName: string) => {
    setCollapsedGroups((prev) => {
      if (!prev.has(providerName)) return prev
      const next = new Set(prev)
      next.delete(providerName)
      return next
    })
    // Явное раскрытие запоминаем, чтобы после сброса фильтра группа не свернулась.
    setExpandedGroups((prev) => {
      if (prev.has(providerName)) return prev
      const next = new Set(prev)
      next.add(providerName)
      return next
    })
  }

  /** Фильтр по провайдеру раскрывает его группу — иначе выбранное не найти. */
  const handleFilterProviderChange = (value: string) => {
    setFilterProvider(value)
    if (value) expandGroup(value)
  }

  const totalModels = total
  const searchTerm = search.trim().toLowerCase()
  const searchActive = searchTerm.length > 0
  // Поиск и фильтры — на сервере: группы приходят уже отфильтрованными,
  // локальной фильтрации списка больше нет.
  const filteredGroups = groups
    .map((g) => ({ provider: g.provider, models: g.models, total: g.models.length }))
    .filter((g) => g.models.length > 0)
  const visibleCount = filteredGroups.reduce((sum, g) => sum + g.models.length, 0)

  const isGroupCollapsed = (group: (typeof filteredGroups)[number]) =>
    !filterProvider && !searchActive && (collapsedGroups.has(group.provider.name)
      || (group.models.length > LARGE_GROUP_THRESHOLD && !expandedGroups.has(group.provider.name)))

  // Плоский список: шапка колонок статична и в items не входит.
  const items: ModelListItem[] = []
  filteredGroups.forEach((group, index) => {
    items.push({
      kind: 'group',
      key: `group:${group.provider.name}`,
      provider: group.provider,
      shown: group.models.length,
      total: group.total,
      collapsed: isGroupCollapsed(group),
    })
    if (!isGroupCollapsed(group)) {
      for (const model of group.models) {
        items.push({
          kind: 'model',
          key: `model:${model.id}`,
          model,
          provider: group.provider,
        })
      }
    }
    if (index < filteredGroups.length - 1) {
      items.push({ kind: 'spacer', key: `spacer:${group.provider.name}` })
    }
  })

  // Скролл-элемент виртуализатора — тело панели настроек: таблица не создаёт
  // второго вертикального скролла (ADR-072), а список остаётся виртуализированным.
  const getScrollElement = useCallback(() => scrollRef.current, [])

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement,
    estimateSize: (i) =>
      items[i].kind === 'group'
        ? (isPhone ? PHONE_GROUP_ROW_HEIGHT : GROUP_ROW_HEIGHT)
        : items[i].kind === 'model'
          ? (isPhone ? PHONE_MODEL_ROW_HEIGHT : MODEL_ROW_HEIGHT)
          : SPACER_ROW_HEIGHT,
    overscan: 8,
    getItemKey: (i) => items[i].key,
    scrollMargin,
  })

  // Смещение списка внутри тела панели: строки виртуального списка отсчитываются
  // от его начала, а не от начала скролл-контейнера.
  const syncScrollMargin = useCallback(() => {
    const list = virtualListRef.current
    const scroller = scrollRef.current
    if (!list || !scroller) return
    const margin =
      list.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop
    setScrollMargin((prev) => (Math.abs(prev - margin) < 1 ? prev : margin))
  }, [])

  useLayoutEffect(() => {
    syncScrollMargin()
  })

  // Содержимое над списком меняет высоту (баннеры, секции, форма добавления) —
  // пересчитываем смещение, иначе строки «уезжают» относительно скролла.
  useLayoutEffect(() => {
    const scroller = scrollRef.current
    if (!scroller || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => syncScrollMargin())
    observer.observe(scroller)
    const content = scroller.firstElementChild
    if (content) observer.observe(content)
    return () => observer.disconnect()
  }, [syncScrollMargin])

  // Смена фильтров/поиска — показываем начало списка (иначе окно «уезжает»).
  const filtersInitRef = useRef(true)
  useEffect(() => {
    if (filtersInitRef.current) {
      filtersInitRef.current = false
      return
    }
    const scroller = scrollRef.current
    const table = tableRef.current
    if (!scroller || !table) return
    scroller.scrollTop +=
      table.getBoundingClientRect().top - scroller.getBoundingClientRect().top
  }, [search, filterProvider, onlyEnabled])

  const enabledProviders = useProvidersStore((s) => s.providers)

  // Эффективная пара: override из настроек, иначе дефолт (legacy-пара провайдера).
  // Пара не задана — показываем первого провайдера, чтобы селект модели был доступен.
  const pairProvider = defaultModel?.provider || defaultsPair?.provider || allProviders[0] || ''
  const pairModel = defaultModel?.model || defaultsPair?.model || ''
  const pairModelOptions = pairProviderModels.length > 0
    ? pairProviderModels
    : enabledModelsOf(pairProvider)

  const formatPrice = (price?: number, currency?: string) => {
    if (price === undefined || price === null) return ''
    return formatMoney(price, currency, { locale })
  }

  const renderGroupHeader = (item: Extract<ModelListItem, { kind: 'group' }>) => (
    <div className="flex flex-wrap items-center gap-3 border-b bg-muted/30 px-4 py-3 min-w-0">
      <button
        onClick={() => toggleGroup(item.provider.name, item.collapsed)}
        className={cn(
          'p-0.5 hover:bg-muted rounded transition-colors shrink-0',
          isPhone && 'h-[var(--control-height-touch)] w-[var(--control-height-touch)] flex items-center justify-center',
        )}
        aria-label={item.provider.name}
      >
        <Icon
          name="arrow-right-s"
          className={cn('size-4 text-muted-foreground transition-transform', !item.collapsed && 'rotate-90')}
        />
      </button>
      <ProviderIcon
        icon={item.provider.icon}
        size={18}
        className="shrink-0"
      />
      <span className="font-medium text-sm min-w-0 break-words">{item.provider.name}</span>
      <span className="text-xs text-muted-foreground">
        {t('admin.models.modelsCount', { count: item.shown })}
      </span>
      {item.provider.defaultModel && (
        <span className="text-xs text-muted-foreground sm:ml-auto sm:mr-2 min-w-0 break-words">
          {t('admin.models.defaultModel', { model: item.provider.defaultModel })}
        </span>
      )}
      <button
        onClick={() => handleFetch(item.provider.name)}
        disabled={fetching !== null}
        className={cn(
          'flex items-center gap-1 px-2 py-1 rounded text-xs bg-muted hover:bg-interactive-hover disabled:opacity-50 shrink-0',
          isPhone && 'h-[var(--control-height-touch)] px-3',
        )}
      >
        <Icon
          name="refresh"
          className={cn('size-3', fetching === item.provider.name && 'animate-spin')}
        />
        {t('admin.models.refresh')}
      </button>
    </div>
  )

  /** Контекстное окно — одинаковый инпут в обеих раскладках. */
  const renderContextInput = (model: ModelInfo) => (
    <input
      type="number"
      min="0"
      step="1000"
      value={model.context_window ?? ''}
      onChange={(e) => handleContextEdit(model, e.target.value)}
      onFocus={(e) => e.target.select()}
      className={cn(
        'w-full text-center bg-background border rounded px-1.5 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-ring tabular-nums',
        isPhone && 'h-[var(--control-height-touch)]',
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
  )

  /** Одно из ценовых полей (вход / выход / чтение кэша / запись кэша). */
  const renderPriceInput = (
    model: ModelInfo,
    placeholder: string,
    value: string,
    onChange: (value: string) => void,
    title: string,
  ) => (
    <input
      type="number"
      min="0"
      step="0.01"
      placeholder={placeholder}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onFocus={() => !editingPrices[model.id] && startEditPrice(model)}
      className={cn(
        'text-center bg-background border rounded px-1 py-1 text-[0.625rem] focus:outline-none focus:ring-1 focus:ring-ring',
        isPhone ? 'w-full min-w-0 h-[var(--control-height-touch)]' : 'w-[calc(50%-0.125rem)]',
      )}
      title={title}
    />
  )

  /** Тумблер «Вкл/Выкл» — одинаков в обеих раскладках (на телефоне — touch-размер). */
  const renderEnabledButton = (model: ModelInfo) => (
    <button
      onClick={() => toggleEnabled(model)}
      className={cn(
        'rounded text-[0.625rem] font-medium transition-colors cursor-pointer',
        isPhone ? 'h-[var(--control-height-touch)] min-w-[3.25rem] px-3' : 'px-2 py-0.5',
        model.enabled
          ? 'bg-status-success/10 text-status-success hover:bg-status-success/20'
          : 'bg-secondary text-muted-foreground hover:bg-interactive-hover',
      )}
      title={model.enabled ? t('admin.models.disableModel') : t('admin.models.enableModel')}
    >
      {model.enabled ? t('common.on').toUpperCase() : t('common.off').toUpperCase()}
    </button>
  )

  /** Пушпин «модель по умолчанию». */
  const renderDefaultButton = (model: ModelInfo, pinLabel: string) => (
    <button
      onClick={() => setAsDefault(model)}
      disabled={!model.enabled}
      className={cn(
        'rounded transition-colors',
        isPhone ? 'h-[var(--control-height-touch)] w-[var(--control-height-touch)] flex items-center justify-center shrink-0' : 'p-0.5',
        model.isDefault
          ? 'text-primary hover:text-primary/80'
          : 'text-muted-foreground/30 hover:text-primary/70',
        !model.enabled && 'disabled:opacity-30 disabled:cursor-default',
      )}
      aria-label={pinLabel}
      title={pinLabel}
    >
      <Icon name="pushpin" className="size-3.5" />
    </button>
  )

  /** Открыть форму модели для редактирования (в т.ч. слой совместимости). */
  const renderEditButton = (model: ModelInfo) => (
    <button
      onClick={() => openEditModel(model)}
      className={cn(
        'rounded text-muted-foreground/60 hover:text-primary transition-colors',
        isPhone
          ? 'h-[var(--control-height-touch)] w-[var(--control-height-touch)] flex items-center justify-center shrink-0'
          : 'p-0.5',
      )}
      aria-label={t('admin.models.editModel')}
      title={t('admin.models.editModel')}
    >
      <Icon name="edit-2" className="size-3.5" />
    </button>
  )

  /** Бейдж «есть сохранённые расширенные параметры» — иначе это не видно в списке. */
  const renderCompatibilityBadge = (model: ModelInfo) => (
    isCompatibilitySaved(model.compatibility) ? (
      <span
        data-testid="model-compatibility-badge"
        className="px-1 py-0.5 rounded text-[0.625rem] font-medium bg-secondary text-secondary-foreground shrink-0"
        title={t('admin.compatibility.title')}
      >
        {t('admin.compatibility.badgeShort')}
      </span>
    ) : null
  )

  /** Удаление модели. */
  const renderDeleteButton = (model: ModelInfo) => (
    <Button
      variant="ghost"
      onClick={() => handleDelete(model.id)}
      className={cn(
        'text-muted-foreground/40 hover:bg-status-error/10 hover:text-status-error',
        isPhone ? 'h-[var(--control-height-touch)] w-[var(--control-height-touch)] p-0 shrink-0' : 'p-0.5',
      )}
      aria-label={t('admin.models.deleteModel')}
      title={t('admin.models.deleteModel')}
    >
      <Icon name="delete-bin" className="size-3.5" />
    </Button>
  )

  const renderModelRow = (item: Extract<ModelListItem, { kind: 'model' }>) => {
    const { model, provider } = item
    const editing = editingPrices[model.id]
    // Валюта цен: модель → провайдер → USD.
    const currency = model.currency ?? provider.currency
    // Выключенную модель нельзя закрепить: подсказка объясняет, что сначала включить.
    const pinLabel = !model.enabled
      ? t('admin.models.enableToDefault')
      : model.isDefault
        ? t('admin.models.defaultModelTitle')
        : t('admin.models.makeDefault')
    return (
      <div className="flex gap-2 px-4 py-2 items-center border-b border-dashed bg-surface-inset hover:bg-interactive-hover text-sm">
        {/* Название модели + иконка */}
        <div className="flex flex-1 min-w-0 items-center gap-2">
          <ProviderIcon
            icon={provider.icon}
            size={14}
            className="shrink-0"
          />
          <div className="min-w-0">
            <span className={cn('font-medium truncate block', !model.enabled && 'opacity-50')}>
              {model.name}
            </span>
          </div>
          {renderCompatibilityBadge(model)}
          {renderEditButton(model)}
        </div>

        {/* Контекстное окно */}
        <div className="w-20 shrink-0 text-center">
          {renderContextInput(model)}
        </div>

        {/* Цены */}
        <div className="w-[8.75rem] shrink-0 flex items-center gap-1 text-[0.625rem] tabular-nums">
          <CurrencyPicker
            value={currency}
            onChange={(next) => setCurrency(model, next)}
          />
          <div className="flex flex-1 flex-wrap gap-1">
            {renderPriceInput(
              model,
              'in',
              editing?.inputPrice ?? model.input_price ?? '',
              (value) => updatePriceField(model.id, 'inputPrice', value),
              formatPrice(model.input_price, currency) || t('admin.models.priceInTitle'),
            )}
            {renderPriceInput(
              model,
              'out',
              editing?.outputPrice ?? model.output_price ?? '',
              (value) => updatePriceField(model.id, 'outputPrice', value),
              formatPrice(model.output_price, currency) || t('admin.models.priceOutTitle'),
            )}
            {renderPriceInput(
              model,
              'cr',
              editing?.cacheReadPrice ?? model.cache_read_price ?? '',
              (value) => updatePriceField(model.id, 'cacheReadPrice', value),
              formatPrice(model.cache_read_price, currency) || t('admin.models.priceCrTitle'),
            )}
            {renderPriceInput(
              model,
              'cw',
              editing?.cacheWritePrice ?? model.cache_write_price ?? '',
              (value) => updatePriceField(model.id, 'cacheWritePrice', value),
              formatPrice(model.cache_write_price, currency) || t('admin.models.priceCwTitle'),
            )}
          </div>
        </div>

        {/* Включено / Выключено */}
        <div className="w-[4.375rem] shrink-0 flex justify-center">
          {renderEnabledButton(model)}
        </div>

        {/* По умолчанию (пара provider+model инстанса) */}
        <div className="w-10 shrink-0 flex justify-center">
          {renderDefaultButton(model, pinLabel)}
        </div>

        {/* Удалить */}
        <div className="w-8 shrink-0 flex justify-center">
          {renderDeleteButton(model)}
        </div>
      </div>
    )
  }

  /**
   * Телефон: та же строка, но перестроенная в карточку — название и действия
   * на первой строке, контекст/вкл — на второй, цены — на третьей. Все поля
   * и все действия остаются на экране: горизонтального скролла нет (ADR-072).
   */
  const renderModelRowPhone = (item: Extract<ModelListItem, { kind: 'model' }>) => {
    const { model, provider } = item
    const editing = editingPrices[model.id]
    const currency = model.currency ?? provider.currency
    const pinLabel = !model.enabled
      ? t('admin.models.enableToDefault')
      : model.isDefault
        ? t('admin.models.defaultModelTitle')
        : t('admin.models.makeDefault')
    return (
      <div className="flex flex-col gap-2 px-3 py-2 border-b border-dashed bg-surface-inset hover:bg-interactive-hover text-sm">
        {/* Название модели + действия */}
        <div className="flex items-center gap-1 min-w-0">
          <ProviderIcon
            icon={provider.icon}
            size={14}
            className="shrink-0"
          />
          <span className={cn('font-medium truncate min-w-0 flex-1', !model.enabled && 'opacity-50')}>
            {model.name}
          </span>
          {renderCompatibilityBadge(model)}
          {renderEditButton(model)}
          {renderDefaultButton(model, pinLabel)}
          {renderDeleteButton(model)}
        </div>

        {/* Контекстное окно + включение */}
        <div className="flex items-center gap-2 min-w-0">
          <span className="shrink-0 text-[0.6875rem] text-muted-foreground">
            {t('admin.models.context')}
          </span>
          <div className="w-24 shrink-0">{renderContextInput(model)}</div>
          <span className="ml-auto shrink-0 text-[0.6875rem] text-muted-foreground">
            {t('admin.models.enabledCol')}
          </span>
          {renderEnabledButton(model)}
        </div>

        {/* Цены: подписи полей сохраняют смысл ввода/выхода без тултипа */}
        <div className="flex items-end gap-2 min-w-0">
          <span className="shrink-0 text-[0.6875rem] text-muted-foreground">
            {t('admin.models.prices')}
          </span>
          <CurrencyPicker
            value={currency}
            onChange={(next) => setCurrency(model, next)}
            className="h-[var(--control-height-touch)] w-[var(--control-height-touch)]"
          />
          <div className="flex-1 min-w-0">
            <div className="grid grid-cols-4 gap-1 mb-0.5">
              <span className="truncate text-center text-[0.5625rem] text-muted-foreground">
                {t('admin.models.priceInShort')}
              </span>
              <span className="truncate text-center text-[0.5625rem] text-muted-foreground">
                {t('admin.models.priceOutShort')}
              </span>
              <span className="truncate text-center text-[0.5625rem] text-muted-foreground">
                {t('admin.models.priceCrShort')}
              </span>
              <span className="truncate text-center text-[0.5625rem] text-muted-foreground">
                {t('admin.models.priceCwShort')}
              </span>
            </div>
            <div className="grid grid-cols-4 gap-1">
              {renderPriceInput(
                model,
                'in',
                editing?.inputPrice ?? model.input_price ?? '',
                (value) => updatePriceField(model.id, 'inputPrice', value),
                formatPrice(model.input_price, currency) || t('admin.models.priceInTitle'),
              )}
              {renderPriceInput(
                model,
                'out',
                editing?.outputPrice ?? model.output_price ?? '',
                (value) => updatePriceField(model.id, 'outputPrice', value),
                formatPrice(model.output_price, currency) || t('admin.models.priceOutTitle'),
              )}
              {renderPriceInput(
                model,
                'cr',
                editing?.cacheReadPrice ?? model.cache_read_price ?? '',
                (value) => updatePriceField(model.id, 'cacheReadPrice', value),
                formatPrice(model.cache_read_price, currency) || t('admin.models.priceCrTitle'),
              )}
              {renderPriceInput(
                model,
                'cw',
                editing?.cacheWritePrice ?? model.cache_write_price ?? '',
                (value) => updatePriceField(model.id, 'cacheWritePrice', value),
                formatPrice(model.cache_write_price, currency) || t('admin.models.priceCwTitle'),
              )}
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <TooltipProvider>
    <SettingsPanel
      title={t('admin.models.title')}
      meta={t('admin.models.count', { visible: visibleCount, total: totalModels, providers: enabledProviders.length })}
      scrollRef={scrollRef}
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
      {/* Поиск и добавление — базовые элементы панели: видны без раскрытия
          дополнительных настроек и стоят первыми (владелец: «перенести вверх»). */}
      <SettingsSection id="models-filters">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <TextField
            id="models-search"
            label={t('admin.models.search')}
            tooltip={t('settings.help.models.search')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('admin.models.searchPlaceholder')}
            aria-label={t('admin.models.searchPlaceholder')}
            containerClassName="min-w-0 flex-1"
          />
          <Button
            variant="outline"
            onClick={openAddForm}
            className="shrink-0 border-dashed hover:border-solid hover:bg-muted"
            data-testid="models-add-button"
          >
            <Icon name="add" className="size-3.5" />
            {t('admin.models.add')}
          </Button>
        </div>
      </SettingsSection>

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

      {/* Модель по умолчанию для новых сессий: пара provider+model уровня инстанса */}
      <SettingsSection
        id="models-default"
        title={t('admin.models.defaultModelSection')}
        description={t('admin.models.defaultModelSectionHint')}
        tooltip={t('settings.help.models.section.models-default')}
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <SelectField
            label={t('admin.models.defaultProvider')}
            tooltip={t('settings.help.models.defaultProvider')}
            value={pairProvider}
            onValueChange={handleDefaultProviderChange}
            ariaLabel={t('admin.models.defaultProvider')}
            disabled={defaultSaving}
            triggerTestId="default-model-provider"
          >
            <SelectContent>
              {allProviders.map((p) => (
                <SelectItem key={p} value={p}>{p}</SelectItem>
              ))}
            </SelectContent>
          </SelectField>
          <SelectField
            label={t('admin.models.defaultModelLabel')}
            tooltip={t('settings.help.models.defaultModelLabel')}
            value={pairModel}
            onValueChange={handleDefaultModelChange}
            ariaLabel={t('admin.models.defaultModelLabel')}
            disabled={defaultSaving || !pairProvider}
            triggerTestId="default-model-model"
          >
            <SelectContent>
              {pairModelOptions.map((m) => (
                <SelectItem key={m.id} value={m.name}>{m.name}</SelectItem>
              ))}
            </SelectContent>
          </SelectField>
        </div>
        <div className="flex flex-wrap items-center gap-2 min-w-0">
          <Button
            variant="outline"
            onClick={handleResetDefaultModel}
            disabled={!isOverridden || defaultSaving}
            data-testid="default-model-reset"
          >
            {t('admin.models.resetDefault')}
          </Button>
          {defaultError && (
            <span className="text-xs text-status-error min-w-0 break-words">{defaultError}</span>
          )}
        </div>
      </SettingsSection>

      {/* Дополнительные фильтры списка */}
      <SettingsSection id="models-filters-advanced" advanced>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <SelectField
            label={t('admin.models.allProviders')}
            tooltip={t('settings.help.models.filterProvider')}
            value={filterProvider}
            onValueChange={handleFilterProviderChange}
            ariaLabel={t('admin.models.allProviders')}
          >
            <SelectContent>
              <SelectItem value="">{t('admin.models.allProviders')}</SelectItem>
              {allProviders.map((p) => (
                <SelectItem key={p} value={p}>{p}</SelectItem>
              ))}
            </SelectContent>
          </SelectField>
          <SelectField
            label={t('admin.models.modality')}
            tooltip={t('settings.help.models.filterModality')}
            value={filterModality}
            onValueChange={setFilterModality}
            ariaLabel={t('admin.models.modality')}
          >
            <SelectContent>
              <SelectItem value="">{t('admin.models.modalityAny')}</SelectItem>
              {MODEL_MODALITIES.map((m) => (
                <SelectItem key={m} value={m}>{t(`admin.models.modality.${m}`)}</SelectItem>
              ))}
            </SelectContent>
          </SelectField>
          <ToggleField
            label={t('admin.models.onlyEnabled')}
            tooltip={t('settings.help.models.onlyEnabled')}
            enabled={onlyEnabled}
            onToggle={() => setOnlyEnabled((v) => !v)}
          />
        </div>
      </SettingsSection>

      {/* Форма добавления — открывается кнопкой «Добавить модель», поэтому
          не «дополнительная»: секция монтируется только по клику. */}
      {showAddForm && (
        <SettingsSection
          id="models-add-manual"
          title={editingModel ? t('admin.models.editManual') : t('admin.models.addManual')}
        >
          {addError && (
            <div className="bg-status-error/10 border border-status-error/30 rounded p-2 text-xs text-status-error min-w-0 break-words">
              {addError}
            </div>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <SelectField
              label={t('admin.models.provider')}
              tooltip={t('settings.help.models.provider')}
              value={addProvider}
              onValueChange={setAddProvider}
              ariaLabel={t('admin.models.provider')}
              disabled={!!editingModel}
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
              tooltip={t('settings.help.models.name')}
              value={addName}
              onChange={(e) => setAddName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleAddModel()}
              placeholder="gpt-4o"
              disabled={!!editingModel}
            />
            <NumberField
              label={t('admin.models.contextK')}
              tooltip={t('settings.help.models.contextK')}
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
                tooltip={t('settings.help.models.priceIn')}
                value={addInPrice}
                onChange={(e) => setAddInPrice(e.target.value)}
                placeholder="0.15"
                step={0.01}
                min={0}
                className="sm:w-full"
              />
              <NumberField
                label={t('admin.models.priceOut')}
                tooltip={t('settings.help.models.priceOut')}
                value={addOutPrice}
                onChange={(e) => setAddOutPrice(e.target.value)}
                placeholder="0.60"
                step={0.01}
                min={0}
                className="sm:w-full"
              />
            </div>
          </div>
          <CompatibilityFields
            key={editingModel?.id ?? 'new'}
            draft={compatibility}
            onChange={setCompatibility}
            saved={hadCompatibility}
          />
          <SettingsActions
            onSave={handleAddModel}
            onCancel={closeAddForm}
            saving={addSaving}
            saveLabel={editingModel ? t('admin.models.save') : t('admin.models.addButton')}
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
      ) : items.length === 0 ? (
        <SettingsSection>
          <p className="py-4 text-center text-muted-foreground">
            {searchActive
              ? t('admin.models.searchEmpty', { query: search.trim() })
              : t('admin.models.empty')}
          </p>
        </SettingsSection>
      ) : (
        // Таблица без собственного скролла: вертикальный скролл — тело панели
        // (ADR-072). Шапка колонок — sticky относительно тела панели.
        <div
          ref={tableRef}
          data-testid="models-scroll"
          className="min-w-0 rounded-lg border border-border"
        >
          <div className={cn(!isPhone && 'min-w-[35rem]')}>
            {/* Шапка колонок — одна на всю таблицу. На телефоне колонки
                перестроены в карточку, поэтому шапка — компактная легенда. */}
            {isPhone ? (
              <div className="sticky top-0 z-10 flex items-center gap-2 rounded-t-lg px-3 py-2 text-[0.6875rem] font-medium text-muted-foreground border-b bg-muted">
                <span className="flex-1 min-w-0 truncate">{t('admin.models.model')}</span>
                <span className="min-w-0 shrink truncate text-right">
                  {t('admin.models.context')} · {t('admin.models.prices')} · {t('admin.models.enabledCol')}
                </span>
              </div>
            ) : (
              <div className="sticky top-0 z-10 flex gap-2 rounded-t-lg px-4 py-2 text-[0.6875rem] font-medium text-muted-foreground border-b bg-muted">
                <span className="flex-1 min-w-0 pl-1">{t('admin.models.model')}</span>
                <span className="w-20 shrink-0 text-center">{t('admin.models.context')}</span>
                <span className="w-[8.75rem] shrink-0 text-center">{t('admin.models.prices')}</span>
                <span className="w-[4.375rem] shrink-0 text-center">{t('admin.models.enabledCol')}</span>
                <span className="w-10 shrink-0 text-center">{t('admin.models.defaultCol')}</span>
                <span className="w-8 shrink-0" />
              </div>
            )}
            <div
              ref={virtualListRef}
              data-testid="models-virtual-list"
              className="relative"
              style={{ height: virtualizer.getTotalSize() }}
            >
              {virtualizer.getVirtualItems().map((vItem) => {
                const item = items[vItem.index]!
                return (
                  <div
                    key={vItem.key}
                    data-index={vItem.index}
                    ref={virtualizer.measureElement}
                    className="absolute left-0 top-0 w-full"
                    style={{ transform: `translateY(${vItem.start - scrollMargin}px)` }}
                  >
                    {item.kind === 'group'
                      ? renderGroupHeader(item)
                      : item.kind === 'model'
                        ? (isPhone ? renderModelRowPhone(item) : renderModelRow(item))
                        : null}
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      )}

      {/* Каталог постраничный: следующая страница — по кнопке. */}
      {nextOffset !== null && items.length > 0 && (
        <div className="flex justify-center pt-1">
          <Button
            variant="outline"
            onClick={() => void loadMore()}
            disabled={loadingMore}
            data-testid="models-load-more"
          >
            <Icon name="loader-2" className={cn('size-3.5', loadingMore && 'animate-spin')} />
            {loadingMore ? t('admin.models.loadingMore') : t('admin.models.showMore')}
          </Button>
        </div>
      )}
    </SettingsPanel>
    </TooltipProvider>
  )
}
