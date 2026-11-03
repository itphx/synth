// Списки выбора модели: предикаты «показывать ли пару провайдер/модель».
//
// Данные каталога (`providersStore`) остаются **полными** — фильтр применяется
// только на рендере списков выбора. Иначе отключённая пара сбрасывалась бы из
// выбора, и ошибка «провайдер/модель отключены» при отправке стала бы
// недостижимой (пользователь не увидел бы, почему запрос блокируется).

/** Минимальный признак включённости провайдера/модели. */
export interface SelectableFlag {
  enabled?: boolean
}

/** Провайдер с именем — для построения карты `providersByName`. */
export interface NamedSelectableProvider extends SelectableFlag {
  name: string
}

/**
 * Провайдер предлагается в списке выбора, если он не отключён администратором.
 * `undefined` — «неизвестно» (legacy/синтетическая запись): не отбрасываем.
 */
export function isSelectableProvider(provider: SelectableFlag | null | undefined): boolean {
  return provider?.enabled !== false
}

/** Карта провайдеров по имени — единая форма для {@link isSelectableModel}. */
export function selectableProvidersByName(
  providers: ReadonlyArray<NamedSelectableProvider>,
): Map<string, SelectableFlag> {
  return new Map(providers.map((p) => [p.name, { enabled: p.enabled }]))
}

/**
 * Модель предлагается в списке выбора: включена сама и её провайдер включён.
 *
 * Провайдер не найден в переданном списке — **не отбрасываем** (гибрид/legacy:
 * метаданных провайдера может не быть; тихая потеря модели запрещена).
 */
export function isSelectableModel(
  model: SelectableFlag & { provider?: string },
  providersByName: ReadonlyMap<string, SelectableFlag>,
): boolean {
  if (model.enabled === false) return false
  if (!model.provider) return true
  const provider = providersByName.get(model.provider)
  if (!provider) return true
  return provider.enabled !== false
}

/** Фильтр массива моделей по доступности (провайдер неизвестен — оставляем). */
export function selectableModels<T extends SelectableFlag & { provider?: string }>(
  models: ReadonlyArray<T>,
  providersByName: ReadonlyMap<string, SelectableFlag>,
): T[] {
  return models.filter((model) => isSelectableModel(model, providersByName))
}
