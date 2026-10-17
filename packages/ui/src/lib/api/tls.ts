// tls: домен API v2 (ADR-095, ADR-099) — доверие TLS/CA, клиентские сертификаты
// и per-host маппинги. Секреты (PEM/ключи) никогда не возвращаются; UI отдаёт их
// только на запись (upload/validate) и не хранит в состоянии после операции.

import { BASE_URL, fetchJSON } from './base'

/** Источник значения TLS: env > runtime > config. */
export type TlsSource = 'env' | 'runtime' | 'config' | 'none'

export interface TlsStatusCa {
  source: TlsSource
  /** Количество сертификатов в CA-бандле. */
  count: number
  /** Subject'ы сертификатов CA (без PEM). */
  subjects: string[]
}

export interface TlsStatusClient {
  source: TlsSource
  certSubject?: string
  hasKey: boolean
  /** `true` — источник env/config (UI только показывает). */
  readOnly: boolean
}

export interface TlsStatusMapping {
  id: string
  hosts: string[]
  label?: string
  certSubject?: string
  source: TlsSource
  readOnly: boolean
}

/** Метаданные для read-only блока «Из параметров». */
export interface TlsStatusParams {
  ca?: { source: TlsSource; caFile?: string; hasPem: boolean }
  client?: { source: TlsSource; certFile?: string; keyFile?: string; readOnly: boolean }
}

export interface TlsStatus {
  ca: TlsStatusCa
  rejectUnauthorized: boolean
  defaultClient?: TlsStatusClient
  mappings: TlsStatusMapping[]
  params: TlsStatusParams
  running?: { applied: boolean; profileIds: string[] }
  saved?: { bootstrap: boolean; profileIds: string[] }
  restartRequired?: boolean
}

/** Ответ мутаций TLS: новый статус, применяется после рестарта. */
export interface TlsMutationResponse {
  status: TlsStatus
  restartRequired: boolean
}

export interface TlsMappingMutationResponse extends TlsMutationResponse {
  mapping: TlsStatusMapping
}

/** Тело мутации несекретных полей `PUT /settings/tls`. */
export interface TlsUpdateInput {
  caFile?: string
  caPem?: string
  rejectUnauthorized?: boolean
}

export interface TlsMappingInput {
  hosts: string[]
  label?: string
  certPem: string
  keyPem: string
}

export interface TlsMappingUpdateInput {
  hosts?: string[]
  label?: string | null
  certPem?: string
  keyPem?: string
}

export interface TlsValidateInput {
  caPem?: string
  certPem?: string
  keyPem?: string
  hosts?: string[]
}

/** `POST /settings/tls/validate` — проверка без записи. */
export interface TlsValidateResult {
  ok: boolean
  caCount?: number
  caSubjects?: string[]
  certSubject?: string
  keyMatches?: boolean
  hostPatternsValid?: boolean
  errors: string[]
}

/**
 * `GET /settings/tls` — плоские поля статуса + saved/running/defaults.
 * Верхнеуровневые `saved`/`running` — сводки применённого/сохранённого набора
 * профилей (не полный статус; полный — в `status.saved`/`status.running`).
 */
export interface TlsGetResponse {
  status: TlsStatus
  ca: TlsStatusCa
  rejectUnauthorized: boolean
  defaultClient?: TlsStatusClient
  mappings: TlsStatusMapping[]
  params: TlsStatusParams
  saved?: { bootstrap: boolean; profileIds: string[] } | null
  running?: { applied: boolean; profileIds: string[] } | null
  defaults: TlsStatus
  restartRequired: boolean
}

export const tlsApi = {
  /** GET /settings/tls — статус CA/клиента/маппингов и источников. */
  async getTls(): Promise<TlsGetResponse> {
    return fetchJSON<TlsGetResponse>(`${BASE_URL}/settings/tls`)
  },

  /** PUT /settings/tls — несекретные поля (caFile/caPem, rejectUnauthorized). */
  async updateTls(tls: TlsUpdateInput): Promise<TlsMutationResponse> {
    return fetchJSON<TlsMutationResponse>(`${BASE_URL}/settings/tls`, {
      method: 'PUT',
      body: JSON.stringify({ tls }),
    })
  },

  /** PUT /settings/tls/ca — загрузить runtime CA-бандл (PEM, 1+ сертификатов). */
  async uploadCa(pem: string): Promise<TlsMutationResponse> {
    return fetchJSON<TlsMutationResponse>(`${BASE_URL}/settings/tls/ca`, {
      method: 'PUT',
      body: JSON.stringify({ pem }),
    })
  },

  /** DELETE /settings/tls/ca — сбросить runtime CA (409 при env CA). */
  async removeCa(): Promise<TlsMutationResponse> {
    return fetchJSON<TlsMutationResponse>(`${BASE_URL}/settings/tls/ca`, {
      method: 'DELETE',
    })
  },

  /** PUT /settings/tls/client — default-клиент (mTLS): cert+key, только запись. */
  async setDefaultClient(certPem: string, keyPem: string): Promise<TlsMutationResponse> {
    return fetchJSON<TlsMutationResponse>(`${BASE_URL}/settings/tls/client`, {
      method: 'PUT',
      body: JSON.stringify({ certPem, keyPem }),
    })
  },

  /** DELETE /settings/tls/client — удалить default-клиент (409 при env/config). */
  async removeDefaultClient(): Promise<TlsMutationResponse> {
    return fetchJSON<TlsMutationResponse>(`${BASE_URL}/settings/tls/client`, {
      method: 'DELETE',
    })
  },

  /** POST /settings/tls/mappings — per-host клиентский сертификат. */
  async createTlsMapping(input: TlsMappingInput): Promise<TlsMappingMutationResponse> {
    return fetchJSON<TlsMappingMutationResponse>(`${BASE_URL}/settings/tls/mappings`, {
      method: 'POST',
      body: JSON.stringify(input),
    })
  },

  /** PUT /settings/tls/mappings/:id — hosts/label (и опционально новая пара cert+key). */
  async updateTlsMapping(
    id: string,
    input: TlsMappingUpdateInput,
  ): Promise<TlsMappingMutationResponse> {
    return fetchJSON<TlsMappingMutationResponse>(
      `${BASE_URL}/settings/tls/mappings/${encodeURIComponent(id)}`,
      {
        method: 'PUT',
        body: JSON.stringify(input),
      },
    )
  },

  /** DELETE /settings/tls/mappings/:id — удалить маппинг. */
  async deleteTlsMapping(id: string): Promise<TlsMutationResponse> {
    return fetchJSON<TlsMutationResponse>(
      `${BASE_URL}/settings/tls/mappings/${encodeURIComponent(id)}`,
      {
        method: 'DELETE',
      },
    )
  },

  /** POST /settings/tls/validate — проверка PEM/hosts без записи. */
  async validateTls(input: TlsValidateInput): Promise<TlsValidateResult> {
    return fetchJSON<TlsValidateResult>(`${BASE_URL}/settings/tls/validate`, {
      method: 'POST',
      body: JSON.stringify(input),
    })
  },
}
