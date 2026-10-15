// models: домен API v2 (ADR-095) — объект `modelsApi` и его DTO.

import type { ProviderGroupInfo } from './providers'
import { BASE_URL, fetchJSON } from './base'
import { normalizeModelInfo } from './modelNormalize'

export interface ModelInfo {
  id: string
  name: string
  provider: string
  description?: string
  enabled: boolean
  isDefault: boolean
  context_window?: number
  context_source?: string
  max_tokens?: number
  input_price?: number
  output_price?: number
  cache_read_price?: number
  cache_write_price?: number
  /** Валюта цен модели; отсутствует → валюта провайдера → USD. */
  currency?: string
}

export interface ModelGroup {
  provider: ProviderGroupInfo
  models: ModelInfo[]
}

export const modelsApi = {
  async getModels(): Promise<ModelGroup[]> {
    const data = await fetchJSON<{
      groups: Array<{ provider: ProviderGroupInfo; models: Array<Record<string, unknown>> }>
    }>(`${BASE_URL}/models`)
    return (data.groups || []).map((g) => ({
      provider: g.provider,
      models: g.models.map((m) => normalizeModelInfo(m) as unknown as ModelInfo),
    }))
  },

  // Модели (admin)
  async fetchModels(providerName?: string): Promise<{
    fetched: number
    new: number
    enriched: number
    priced?: number
    limited?: number
    errors?: string[]
  }> {
    const params = providerName ? `?provider=${encodeURIComponent(providerName)}` : ''
    return fetchJSON(`${BASE_URL}/models/fetch${params}`, { method: 'POST' })
  },

  async saveModel(data: Record<string, unknown>): Promise<ModelInfo> {
    return fetchJSON<ModelInfo>(`${BASE_URL}/models`, {
      method: 'POST',
      body: JSON.stringify(data),
    })
  },

  async deleteModel(modelId: string): Promise<void> {
    return fetchJSON<void>(`${BASE_URL}/models/${encodeURIComponent(modelId)}`, {
      method: 'DELETE',
    })
  },
}
