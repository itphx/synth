// users: домен API v2 (ADR-095) — объект `usersApi` и его DTO.

import { BASE_URL, fetchJSON } from './base'

export interface UserInfo {
  id: string
  username: string
  email: string | null
  roles: string[]
  team_roles: string[]
  display_name: string | null
  is_active: boolean
  notes: string
  preferences: Record<string, unknown>
  created_at: string
  updated_at: string
  last_login: string | null
}

export interface UsersListResponse {
  users: UserInfo[]
}

/**
 * PROP-133 §3.3: запись каталога пользователей (`GET /api/v2/users/directory`).
 *
 * Лёгкая проекция для выбора участников проекта: только `id`, `username` и
 * `display_name` — ролей, почты, идентичностей и заметок в каталоге нет.
 */
export interface DirectoryUser {
  id: string
  username: string
  display_name: string | null
}

/**
 * Страница каталога пользователей (ADR-118 §4 — постранично, как прочие списки).
 *
 * `next_offset` — курсор следующей страницы, `null` — страница последняя.
 */
export interface UsersDirectoryPage {
  users: DirectoryUser[]
  /** Всего пользователей (больше, чем в загруженной странице). */
  total: number
  offset: number
  limit: number
  next_offset: number | null
}

/** Параметры страницы каталога пользователей. */
export interface UsersDirectoryParams {
  /** Размер страницы (сервер: по умолчанию 50, максимум 200). */
  limit?: number
  /** Смещение страницы (номер первого элемента). */
  offset?: number
  /** Поиск по `username`/`display_name` (без учёта регистра). */
  q?: string
}

/**
 * ADR-140 Ф2: запись каталога групп (`GET /api/v2/users/groups`).
 *
 * Лёгкая проекция: только имя группы — участников и описаний в каталоге нет.
 */
export interface GroupEntry {
  name: string
}

/**
 * Страница каталога групп (ADR-118 §4 — постранично, как прочие списки).
 *
 * `next_offset` — курсор следующей страницы, `null` — страница последняя.
 */
export interface GroupsDirectoryPage {
  groups: GroupEntry[]
  /** Всего групп в каталоге (больше, чем в загруженной странице). */
  total: number
  offset: number
  limit: number
  next_offset: number | null
}

/** Параметры страницы каталога групп. */
export interface GroupsDirectoryParams {
  /** Размер страницы (сервер: по умолчанию 50, максимум 200). */
  limit?: number
  /** Смещение страницы (номер первого элемента). */
  offset?: number
  /** Поиск по имени группы (без учёта регистра). */
  q?: string
}

/**
 * ADR-140 Ф2: каталог групп инстанса — для грантов доступа по группам.
 *
 * Доступ — любому аутентифицированному пользователю (иначе владелец
 * проекта физически не может выбрать группу). В standalone раздела
 * пользователей нет (`features.users === false`) — вызывающий не должен
 * дёргать эндпоинт.
 */
export async function getGroupsDirectory(
  params?: GroupsDirectoryParams,
): Promise<GroupsDirectoryPage> {
  const query = new URLSearchParams()
  if (params?.limit !== undefined) query.set('limit', String(params.limit))
  if (params?.offset !== undefined) query.set('offset', String(params.offset))
  if (params?.q) query.set('q', params.q)
  const qs = query.toString()
  return fetchJSON<GroupsDirectoryPage>(`${BASE_URL}/users/groups${qs ? `?${qs}` : ''}`)
}

export const usersApi = {
  // Пользователи (admin)
  async getUsers(): Promise<UsersListResponse> {
    return fetchJSON<UsersListResponse>(`${BASE_URL}/users`)
  },

  /**
   * PROP-133 §3.3: каталог пользователей для выбора участников проекта.
   *
   * Доступ — любому аутентифицированному пользователю (иначе владелец
   * проекта физически не может выбрать участников: `/users` — только ADMIN).
   * В standalone раздела пользователей нет (`features.users === false`) —
   * вызывающий не должен дёргать эндпоинт.
   */
  async getDirectory(params?: UsersDirectoryParams): Promise<UsersDirectoryPage> {
    const query = new URLSearchParams()
    if (params?.limit !== undefined) query.set('limit', String(params.limit))
    if (params?.offset !== undefined) query.set('offset', String(params.offset))
    if (params?.q) query.set('q', params.q)
    const qs = query.toString()
    return fetchJSON<UsersDirectoryPage>(`${BASE_URL}/users/directory${qs ? `?${qs}` : ''}`)
  },

  async getUser(id: string): Promise<UserInfo> {
    return fetchJSON<UserInfo>(`${BASE_URL}/users/${encodeURIComponent(id)}`)
  },

  async createUser(data: Record<string, unknown>): Promise<UserInfo> {
    return fetchJSON<UserInfo>(`${BASE_URL}/users`, {
      method: 'POST',
      body: JSON.stringify(data),
    })
  },

  async updateUser(id: string, data: Record<string, unknown>): Promise<UserInfo> {
    return fetchJSON<UserInfo>(`${BASE_URL}/users/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    })
  },

  async deleteUser(id: string): Promise<void> {
    return fetchJSON<void>(`${BASE_URL}/users/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    })
  },
}
