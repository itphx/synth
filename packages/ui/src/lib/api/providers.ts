// providers: домен API v2 (ADR-095) — объект `providersApi` и его DTO.

import { BASE_URL, fetchJSON } from './base'

export interface ProviderInfo {
  name: string
  type: string
  icon: string
  url: string
  model: string
  enabled: boolean
  is_default?: boolean
  /** Валюта по умолчанию для моделей провайдера. */
  currency?: string
}

/** Результат `POST /providers/fetch-icon` (admin). */
export interface ProviderFetchIconResult {
  icon?: string | null
  error?: string
  source?: string
}

export interface ProviderGroupInfo {
  name: string
  type: string
  icon: string
  defaultModel: string
  currency?: string
}

export const providersApi = {
  // Провайдеры и модели
  async getProviders(): Promise<{ providers: ProviderInfo[]; default_provider: string }> {
    const data = await fetchJSON<{ providers: ProviderInfo[]; default_provider: string }>(`${BASE_URL}/providers`)
    return { providers: data.providers || [], default_provider: data.default_provider }
  },

  // Провайдеры (admin)
  async createProvider(data: Record<string, unknown>): Promise<ProviderInfo> {
    return fetchJSON<ProviderInfo>(`${BASE_URL}/providers`, {
      method: 'POST',
      body: JSON.stringify(data),
    })
  },

  async updateProvider(name: string, data: Record<string, unknown>): Promise<ProviderInfo> {
    return fetchJSON<ProviderInfo>(`${BASE_URL}/providers/${encodeURIComponent(name)}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    })
  },

  async deleteProvider(name: string): Promise<void> {
    return fetchJSON<void>(`${BASE_URL}/providers/${encodeURIComponent(name)}`, {
      method: 'DELETE',
    })
  },

  async testProvider(name: string): Promise<{
    status: string
    error?: string
    models?: string[]
    message?: string
  }> {
    return fetchJSON(`${BASE_URL}/providers/${encodeURIComponent(name)}/test`, {
      method: 'POST',
    })
  },

  async fetchProviderIcon(url: string): Promise<ProviderFetchIconResult> {
    return fetchJSON<ProviderFetchIconResult>(`${BASE_URL}/providers/fetch-icon`, {
      method: 'POST',
      body: JSON.stringify({ url }),
    })
  },
}
