// egress: домен API v2 (ADR-095) — объект `egressApi` и его DTO.
//
// Адресная egress-политика исходящих запросов (`tools`/`webhooks`) +
// offline-проверка URL и журналы безопасности (`/audit/security`, `/audit/egress`).
// Формат политики — `@itphx/synth-shared/types` (единый с MCP-политикой).

import type {
  EgressPolicy,
  EgressPolicyScope,
  EgressRequestLogEntry,
  EgressRequestScope,
  EgressRequestStatus,
  McpNetworkPolicy,
  SecurityAuditEntry,
  SecurityAuditScope,
  WebhooksEgressPolicy,
} from '@itphx/synth-shared/types'
import { BASE_URL, fetchJSON } from './base'

/** Скоуп offline-проверки URL (`POST /settings/egress/check`). */
export type EgressCheckScope = 'tools' | 'webhooks' | 'mcp'

export type AnyEgressPolicy = EgressPolicy | WebhooksEgressPolicy | McpNetworkPolicy

/** Настраиваемая политика `/settings/egress/:scope` (без MCP-варианта). */
export type ConfiguredEgressPolicy = EgressPolicy | WebhooksEgressPolicy

/** Ответ GET /settings/egress/:scope (и GET /settings/mcp-network-policy). */
export interface EgressPolicyInfo<P extends AnyEgressPolicy = AnyEgressPolicy> {
  policy: P
  isOverridden: boolean
  defaults: P
}

/** Ответ POST /settings/egress/check — запрос не выполняется. */
export interface EgressCheckResult {
  allowed: boolean
  reason?: string
  matchedRule?: string
  addresses?: string[]
  policy: AnyEgressPolicy
}

/** Ответ GET /audit/security — аудит изменений egress/security-политик. */
export interface SecurityAuditListResponse {
  entries: SecurityAuditEntry[]
  count: number
}

/** Ответ GET /audit/egress — журнал внешних запросов. */
export interface EgressLogListResponse {
  entries: EgressRequestLogEntry[]
  count: number
}

function buildQuery(params: Array<[string, string | number | undefined]>): string {
  const q = new URLSearchParams()
  for (const [key, value] of params) {
    if (value === undefined || value === '') continue
    q.set(key, String(value))
  }
  const qs = q.toString()
  return qs ? `?${qs}` : ''
}

export const egressApi = {
  // --- Egress-политика: tools / webhooks (runtime, поверх config.yaml) ---
  async getEgressPolicy(
    scope: EgressPolicyScope,
  ): Promise<EgressPolicyInfo<ConfiguredEgressPolicy>> {
    return fetchJSON<EgressPolicyInfo<ConfiguredEgressPolicy>>(
      `${BASE_URL}/settings/egress/${scope}`,
    )
  },

  async saveEgressPolicy(
    scope: EgressPolicyScope,
    policy: ConfiguredEgressPolicy,
  ): Promise<ConfiguredEgressPolicy> {
    return fetchJSON<{ policy: ConfiguredEgressPolicy }>(
      `${BASE_URL}/settings/egress/${scope}`,
      {
        method: 'PUT',
        body: JSON.stringify({ policy }),
      },
    ).then((r) => r.policy)
  },

  /** DELETE /settings/egress/:scope — сброс к config-дефолту (live-применение). */
  async resetEgressPolicy(scope: EgressPolicyScope): Promise<ConfiguredEgressPolicy> {
    return fetchJSON<{ policy: ConfiguredEgressPolicy }>(
      `${BASE_URL}/settings/egress/${scope}`,
      {
        method: 'DELETE',
      },
    ).then((r) => r.policy)
  },

  /**
   * POST /settings/egress/check — offline-проверка URL: разбор + DNS + сверка с
   * политикой. Сам HTTP-запрос не выполняется (защита эндпоинта от SSRF-зонда).
   */
  async checkEgress(scope: EgressCheckScope, url: string): Promise<EgressCheckResult> {
    return fetchJSON<EgressCheckResult>(`${BASE_URL}/settings/egress/check`, {
      method: 'POST',
      body: JSON.stringify({ scope, url }),
    })
  },

  // --- Журналы безопасности ---
  async getSecurityAudit(limit?: number, scope?: SecurityAuditScope): Promise<SecurityAuditListResponse> {
    return fetchJSON<SecurityAuditListResponse>(
      `${BASE_URL}/audit/security${buildQuery([
        ['limit', limit],
        ['scope', scope],
      ])}`,
    )
  },

  async getEgressLog(
    limit?: number,
    scope?: EgressRequestScope,
    status?: EgressRequestStatus,
  ): Promise<EgressLogListResponse> {
    return fetchJSON<EgressLogListResponse>(
      `${BASE_URL}/audit/egress${buildQuery([
        ['limit', limit],
        ['scope', scope],
        ['status', status],
      ])}`,
    )
  },
}
