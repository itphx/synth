// dictionaries: домен API v2 (ADR-095) — объект `dictionariesApi` и его DTO.

import { BASE_URL, fetchJSON } from './base'

/** Словарь классификации (ADR-034/ADR-035): GET/PUT/DELETE /api/v2/dictionaries. */
export interface DictionaryEntry {
  category: string
  language: string
  source: 'system' | 'user'
  keywords: string[]
  tools?: string[]
  /** Размер действующего содержимого (YAML) в байтах. */
  size: number
}

/** Словарь классификации с действующим содержимым (YAML) — ответ GET/PUT/DELETE элемента. */
export interface DictionaryDetail extends DictionaryEntry {
  content: string
}

export const dictionariesApi = {
  // --- Словари классификации (ADR-034/ADR-035) ---
  async getDictionaries(): Promise<{ dictionaries: DictionaryEntry[] }> {
    return fetchJSON<{ dictionaries: DictionaryEntry[] }>(`${BASE_URL}/dictionaries`)
  },

  async getDictionary(category: string, lang: string): Promise<{ dictionary: DictionaryDetail }> {
    return fetchJSON<{ dictionary: DictionaryDetail }>(
      `${BASE_URL}/dictionaries/${encodeURIComponent(category)}/${encodeURIComponent(lang)}`,
    )
  },

  async saveDictionary(
    category: string,
    lang: string,
    data: { content: string },
  ): Promise<{ status: string; dictionary: DictionaryDetail }> {
    return fetchJSON<{ status: string; dictionary: DictionaryDetail }>(
      `${BASE_URL}/dictionaries/${encodeURIComponent(category)}/${encodeURIComponent(lang)}`,
      {
        method: 'PUT',
        body: JSON.stringify(data),
      },
    )
  },

  async resetDictionary(category: string, lang: string): Promise<{ status: string; dictionary: DictionaryDetail }> {
    return fetchJSON<{ status: string; dictionary: DictionaryDetail }>(
      `${BASE_URL}/dictionaries/${encodeURIComponent(category)}/${encodeURIComponent(lang)}`,
      { method: 'DELETE' },
    )
  },
}
