import { useMemo } from 'react'
import { isSelectableModel, isSelectableProvider, selectableProvidersByName } from '@/lib/modelOptions'
import { SelectContent, SelectItem } from '../select'
import { SelectField } from './controls/SelectField'

export interface ModelPairOption {
  name: string
  provider?: string
  enabled?: boolean
}

export interface ModelPairSelectProps {
  label: string
  provider: string
  model: string
  providers: ModelPairOption[]
  models: ModelPairOption[]
  /** Текст пустого пункта/aria-label для провайдера (уже локализованный). */
  providerLabel: string
  /** Текст пустого пункта/aria-label для модели (уже локализованный). */
  modelLabel: string
  onProviderChange: (v: string) => void
  onModelChange: (v: string) => void
  /**
   * `compact` — плотная раскладка панели сессии; `settings` — стандартная
   * раскладка панели настроек (колонка на теле, строка с `sm`).
   */
  variant?: 'compact' | 'settings'
  /**
   * Фильтровать провайдеров по `enabled`, модели — по `enabled` и совпадению
   * `provider`. Если список уже подготовлен вызывающим — оставить `false`.
   */
  filterOptions?: boolean
  /** Если задан, aria-label = `${ariaLabelPrefix} — <label>`; иначе — только `<label>`. */
  ariaLabelPrefix?: string
  /** `data-testid` триггера провайдера (для тестов и e2e). */
  providerTestId?: string
  /** `data-testid` триггера модели (для тестов и e2e). */
  modelTestId?: string
  /** ADR-089: подсказка-иконка (ⓘ) у селектора провайдера. */
  providerTooltip?: string
  /** ADR-089: подсказка-иконка (ⓘ) у селектора модели. */
  modelTooltip?: string
}

/** Пара селекторов «провайдер — модель»; используется в роутинге сессии и настроек. */
export function ModelPairSelect({
  label,
  provider,
  model,
  providers,
  models,
  providerLabel,
  modelLabel,
  onProviderChange,
  onModelChange,
  variant = 'settings',
  filterOptions = false,
  ariaLabelPrefix,
  providerTestId,
  modelTestId,
  providerTooltip,
  modelTooltip,
}: ModelPairSelectProps) {
  const compact = variant === 'compact'
  // `undefined`/отсутствующее поле — «неизвестно»: не отбрасываем (legacy,
  // синтетические записи). `filterOptions` — списки не должны предлагать модель
  // отключённого провайдера.
  const providersByName = useMemo(() => selectableProvidersByName(providers), [providers])
  const availableProviders = filterOptions
    ? providers.filter((p) => isSelectableProvider(p))
    : providers
  const filteredModels = filterOptions
    ? models.filter(
        (m) =>
          isSelectableModel({ provider: m.provider ?? provider, enabled: m.enabled }, providersByName)
          && (!provider || m.provider === provider),
      )
    : models
  /**
   * Текущее значение видно всегда: каталог моделей постраничный, выбранная
   * модель может быть не на загруженной странице — иначе селект выглядел бы
   * пустым (значение не из списка).
   */
  const availableModels = useMemo(() => {
    if (!model) return filteredModels
    if (filteredModels.some((m) => m.name === model)) return filteredModels
    return [...filteredModels, { name: model, provider, enabled: true }]
  }, [filteredModels, model, provider])

  const ariaPrefix = ariaLabelPrefix ?? (compact ? label : undefined)
  const providerAria = ariaPrefix ? `${ariaPrefix} — ${providerLabel}` : providerLabel
  const modelAria = ariaPrefix ? `${ariaPrefix} — ${modelLabel}` : modelLabel

  const handleProviderChange = (value: string) => {
    onProviderChange(value)
    onModelChange('')
  }

  const providerSelect = (
    <SelectField
      label={compact ? undefined : providerLabel}
      value={provider}
      onValueChange={handleProviderChange}
      ariaLabel={providerAria}
      tooltip={compact ? undefined : providerTooltip}
      triggerTestId={providerTestId}
    >
      <SelectContent>
        <SelectItem value="">{providerLabel}</SelectItem>
        {availableProviders.map((p) => (
          <SelectItem key={p.name} value={p.name}>{p.name}</SelectItem>
        ))}
      </SelectContent>
    </SelectField>
  )

  const modelSelect = (
    <SelectField
      label={compact ? undefined : modelLabel}
      value={model}
      onValueChange={onModelChange}
      ariaLabel={modelAria}
      tooltip={compact ? undefined : modelTooltip}
      triggerTestId={modelTestId}
    >
      <SelectContent>
        <SelectItem value="">{modelLabel}</SelectItem>
        {availableModels.map((m) => (
          <SelectItem key={m.name} value={m.name}>{m.name}</SelectItem>
        ))}
      </SelectContent>
    </SelectField>
  )

  return (
    <div className={compact ? 'space-y-1' : 'space-y-2 min-w-0'}>
      <span
        className={
          compact
            ? 'text-[0.625rem] text-muted-foreground/60'
            : 'text-sm text-muted-foreground min-w-0 break-words'
        }
      >
        {label}
      </span>
      {compact ? (
        <div className="flex gap-1">
          {providerSelect}
          {modelSelect}
        </div>
      ) : (
        <div className="flex flex-col gap-2 sm:flex-row min-w-0">
          <div className="flex-1 min-w-0">{providerSelect}</div>
          <div className="flex-1 min-w-0">{modelSelect}</div>
        </div>
      )}
    </div>
  )
}
