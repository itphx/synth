import { useEffect } from 'react'

import { useProvidersStore } from '@/stores/providersStore'

/**
 * Полный каталог моделей для **списков выбора** (панель сессии, роутинг,
 * decision, aux-модели, аналитика).
 *
 * Каталог на сервере постраничный; админка и чат используют страницу/поиск, а
 * селекторам нужен весь набор — иначе модель вне загруженной страницы
 * недоступна. `loadCatalogModels` грузит все страницы один раз (до 5000
 * моделей), после чего `catalogModels` — полный список. До загрузки/при ошибке
 * возвращается текущая страница (`models`) — поведение не хуже прежнего.
 */
export function useCatalogModels() {
  const catalog = useProvidersStore((s) => s.catalogModels) ?? []
  const page = useProvidersStore((s) => s.models) ?? []
  const loaded = useProvidersStore((s) => s.catalogLoaded) ?? false
  const loading = useProvidersStore((s) => s.catalogLoading) ?? false
  const load = useProvidersStore((s) => s.loadCatalogModels)

  useEffect(() => {
    if (typeof load === 'function' && !loaded && !loading) void load()
  }, [loaded, loading, load])

  return catalog.length > 0 ? catalog : page
}
