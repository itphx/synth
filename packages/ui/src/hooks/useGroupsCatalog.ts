// Каталог групп инстанса (ADR-140 Ф2) — для грантов доступа по группам.
// Единственный источник — `GET /api/v2/users/groups` (постранично, как прочие
// списки, ADR-118 §4).
//
// Фича `features.users` объявляет сервер (`GET /api/v2/meta`): в standalone
// раздела пользователей нет — хук в этом режиме молчит и пуст (fail-closed:
// выбирать некого).

import { useCallback, useEffect, useState } from 'react'

import { synthApi, type GroupEntry } from '@/lib/api/synthApi'

/** Размер страницы каталога групп (сервер: по умолчанию 50, максимум 200). */
export const GROUPS_CATALOG_LIMIT = 100

/** Задержка перезапроса каталога при вводе поиска (мс). */
export const GROUPS_CATALOG_SEARCH_DEBOUNCE_MS = 250

export interface GroupsCatalog {
  /** Загруженные группы текущей страницы. */
  groups: GroupEntry[]
  /** Всего групп в каталоге (больше, чем в загруженной странице). */
  total: number
  /** Идёт ли загрузка. */
  loading: boolean
  /** Каталог недоступен (ошибка сети/прав) — выбор групп пуст. */
  failed: boolean
  /** Поисковый запрос (ввод пользователя). */
  query: string
  /** Установить поисковый запрос. */
  setQuery: (query: string) => void
  /** Перечитать каталог (повтор запроса с теми же параметрами). */
  reload: () => void
}

/** Параметры загрузки каталога групп. */
export interface GroupsCatalogOptions {
  /** Размер страницы каталога (по умолчанию `GROUPS_CATALOG_LIMIT`). */
  limit?: number
}

/**
 * Загрузка каталога групп с поиском по серверу.
 *
 * `enabled` — признак `features.users` от сервера: без него запросы не
 * идут (эндпоинта может не быть вовсе).
 */
export function useGroupsCatalog(
  enabled: boolean,
  options?: GroupsCatalogOptions,
): GroupsCatalog {
  const limit = options?.limit ?? GROUPS_CATALOG_LIMIT
  const [groups, setGroups] = useState<GroupEntry[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState('')
  const [reloadToken, setReloadToken] = useState(0)

  /** Перечитывание каталога: тот же запрос, но заново (после смены прав). */
  const reload = useCallback(() => setReloadToken((token) => token + 1), [])

  // Поиск — с задержкой (серверный `q`, а не локальная фильтрация):
  // каталог постраничный, локальный фильтр резал бы только загруженную страницу.
  useEffect(() => {
    if (!enabled) return
    const timer = setTimeout(() => setSearch(query.trim()), GROUPS_CATALOG_SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [enabled, query])

  useEffect(() => {
    if (!enabled) {
      setGroups([])
      setTotal(0)
      setFailed(false)
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    synthApi
      .getGroupsDirectory({
        limit,
        ...(search ? { q: search } : {}),
      })
      .then((page) => {
        if (cancelled) return
        const list = page.groups ?? []
        setGroups(list)
        setTotal(typeof page.total === 'number' ? page.total : list.length)
        setFailed(false)
      })
      .catch(() => {
        if (cancelled) return
        setGroups([])
        setTotal(0)
        setFailed(true)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [enabled, search, limit, reloadToken])

  return { groups, total, loading, failed, query, setQuery, reload }
}
