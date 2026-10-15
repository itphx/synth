// context: домен API v2 (ADR-095) — объект `contextApi` и его DTO.

import { BASE_URL, fetchJSON } from './base'

/** Элемент файла контекста (admin: `GET /context/files`). */
export interface ContextFileEntry {
  name: string
  category: string
  is_system: boolean
  is_overridden: boolean
  enabled: boolean
  size: number
  content?: string
}

export const contextApi = {
  // Контекст (admin)
  async getContextFiles(category: string): Promise<{ files: ContextFileEntry[] }> {
    return fetchJSON(`${BASE_URL}/context/files?category=${encodeURIComponent(category)}`)
  },

  async getContextFile(name: string, category: string): Promise<{ name: string; content: string }> {
    return fetchJSON(
      `${BASE_URL}/context/files/${encodeURIComponent(name)}?category=${encodeURIComponent(category)}`,
    )
  },

  async saveContextFile(name: string, content: string, category: string): Promise<void> {
    return fetchJSON<void>(`${BASE_URL}/context/files/${encodeURIComponent(name)}`, {
      method: 'POST',
      body: JSON.stringify({ content, category }),
    })
  },

  async toggleContextFile(name: string): Promise<{ name: string; enabled: boolean }> {
    return fetchJSON(`${BASE_URL}/context/files/${encodeURIComponent(name)}`, {
      method: 'POST',
      body: JSON.stringify({ action: 'toggle' }),
    })
  },

  async deleteContextFile(name: string, category: string): Promise<void> {
    return fetchJSON<void>(
      `${BASE_URL}/context/files/${encodeURIComponent(name)}?category=${encodeURIComponent(category)}`,
      { method: 'DELETE' },
    )
  },

  async resetContextFile(name: string, category: string): Promise<void> {
    return fetchJSON<void>(
      `${BASE_URL}/context/files/${encodeURIComponent(name)}/restore_to_default?category=${encodeURIComponent(category)}`,
      { method: 'POST' },
    )
  },
}
