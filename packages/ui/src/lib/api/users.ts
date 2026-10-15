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

export const usersApi = {
  // Пользователи (admin)
  async getUsers(): Promise<UsersListResponse> {
    return fetchJSON<UsersListResponse>(`${BASE_URL}/users`)
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
