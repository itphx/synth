// Каталог пользователей инстанса (PROP-133 §3.3) — для выбора участников
// проекта. Единственный источник — `GET /api/v2/users/directory` (постранично,
// как прочие списки, ADR-118 §4).
//
// Фича `features.users` объявляет сервер (`GET /api/v2/meta`): в standalone
// раздела пользователей нет — хук в этом режиме молчит и пуст (fail-closed:
// выбирать некого).

import { useEffect, useState } from 'react'

import { synthApi, type DirectoryUser } from '@/lib/api/synthApi'

/** Размер страницы каталога (сервер: по умолчанию 50, максимум 200). */
export const USERS_DIRECTORY_LIMIT = 100

/** Задержка перезапроса каталога при вводе поиска (мс). */
export const USERS_DIRECTORY_SEARCH_DEBOUNCE_MS = 250

export interface UsersDirectory {
  /** Загруженные пользователи текущей страницы. */
  users: DirectoryUser[]
  /** Всего пользователей в каталоге (больше, чем в загруженной странице). */
  total: number
  /** Идёт ли загрузка. */
  loading: boolean
  /** Каталог недоступен (ошибка сети/прав) — выбор пользователей пуст. */
  failed: boolean
  /** Поисковый запрос (ввод пользователя). */
  query: string
  /** Установить поисковый запрос. */
  setQuery: (query: string) => void
}

/** Параметры загрузки каталога пользователей. */
export interface UsersDirectoryOptions {
  /** Размер страницы каталога (по умолчанию `USERS_DIRECTORY_LIMIT`). */
  limit?: number
}

/**
 * Загрузка каталога пользователей с поиском по серверу.
 *
 * `enabled` — признак `features.users` от сервера: без него запросы не
 * идут (эндпоинта может не быть вовсе).
 */
export function useUsersDirectory(
  enabled: boolean,
  options?: UsersDirectoryOptions,
): UsersDirectory {
  const limit = options?.limit ?? USERS_DIRECTORY_LIMIT
  const [users, setUsers] = useState<DirectoryUser[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState('')

  // Поиск — с задержкой (серверный `q`, а не локальная фильтрация):
  // каталог постраничный, локальный фильтр резал бы только загруженную страницу.
  useEffect(() => {
    if (!enabled) return
    const timer = setTimeout(() => setSearch(query.trim()), USERS_DIRECTORY_SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [enabled, query])

  useEffect(() => {
    if (!enabled) {
      setUsers([])
      setTotal(0)
      setFailed(false)
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    synthApi
      .getDirectory({
        limit,
        ...(search ? { q: search } : {}),
      })
      .then((page) => {
        if (cancelled) return
        const list = page.users ?? []
        setUsers(list)
        setTotal(typeof page.total === 'number' ? page.total : list.length)
        setFailed(false)
      })
      .catch(() => {
        if (cancelled) return
        setUsers([])
        setTotal(0)
        setFailed(true)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [enabled, search, limit])

  return { users, total, loading, failed, query, setQuery }
}
