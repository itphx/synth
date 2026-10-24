// oauth: домен API v2 (ADR-105 Ф4) — внешние доступы к OAuth-коннекторам.
//
// Секрет наружу не отдаётся никогда: ответы содержат только метаданные
// (`ExternalCredentialMeta` с маской `secretMask`). Значение токена доступно
// лишь серверному транспорту MCP (`engine/mcp/credential-auth.ts`).

import type { ExternalCredentialMeta } from '@itphx/synth-shared'
import { BASE_URL, fetchJSON } from './base'

/** Способ выдачи доступа (ADR-105 Ф4). */
export type OAuthFlowKind = 'authorize' | 'device'

/**
 * Старт выдачи (один эндпоинт обслуживает обе фазы):
 * - **PKCE** (`authorize`) — `authorizationUrl` + `state`;
 * - **device flow** (`device`) — `userCode`/`verificationUri` + `state`.
 */
export interface OAuthAuthorizationStart {
  flow: 'started'
  /** `state` незавершённой выдачи (нужен для завершения). */
  state: string
  /** Ссылка авторизации (PKCE, RFC 6749 §4.1). */
  authorizationUrl?: string
  /** Код для провайдера (device flow, RFC 8628). */
  userCode?: string
  /** Адрес подтверждения (device flow). */
  verificationUri?: string
  /** Адрес подтверждения с подставленным кодом (device flow). */
  verificationUriComplete?: string
  /** Интервал опроса, с (device flow). */
  interval?: number
  /** Срок незавершённой выдачи (ISO-8601). */
  expiresAt?: string
}

/** Выдача завершена — доступ сохранён. */
export interface OAuthFlowCompleted {
  flow: 'completed'
  credential: ExternalCredentialMeta
}

/** Device flow: авторизация ещё не подтверждена пользователем. */
export interface OAuthFlowPending {
  flow: 'pending'
  interval?: number
  expiresAt?: string
}

/** Ответ `POST /oauth/credentials` — одна из трёх фаз выдачи. */
export type OAuthFlowResponse = OAuthAuthorizationStart | OAuthFlowCompleted | OAuthFlowPending

/** Тело `POST /oauth/credentials` (создание либо завершение выдачи). */
export interface OAuthCredentialCreateInput {
  /** Ключ OAuth-провайдера из каталога `oauth.providers`. */
  provider: string
  /** Способ выдачи; по умолчанию — `authorize`. */
  flow?: OAuthFlowKind
  /** Код авторизации (завершение `authorize`-фазы). */
  code?: string
  /** `state` незавершённой выдачи (завершение `authorize`/`device`-фазы). */
  state?: string
  /** Запрошенные scope'ы (пусто — scope'ы провайдера). */
  scopes?: string[]
  /** `redirect_uri` (по умолчанию — из описания провайдера). */
  redirectUri?: string
  /** Привязка доступа к проекту. */
  projectId?: string
  /** Привязка доступа к MCP-коннектору при выдаче. */
  connectorId?: string
  /** Вид владения: `user` (по умолчанию) или `instance` (`ADMIN`/`LEAD`). */
  ownerKind?: 'user' | 'instance'
}

/** Ответ привязки доступа к MCP-коннектору. */
export interface OAuthCredentialBindResult {
  credentialId: string
  connectorId: string
  bound: boolean
}

/** Ответ отзыва доступа (локальный + best-effort RFC 7009 у провайдера). */
export interface OAuthCredentialRevokeResult {
  credential: ExternalCredentialMeta
  providerRevoked: boolean
}

export const oauthApi = {
  // --- Внешние доступы (ADR-105 Ф4) ---
  /** GET /oauth/credentials — список метаданных доступов (без секретов). */
  async getOAuthCredentials(): Promise<{ credentials: ExternalCredentialMeta[]; count: number }> {
    return fetchJSON<{ credentials: ExternalCredentialMeta[]; count: number }>(
      `${BASE_URL}/oauth/credentials`,
    )
  },

  /** GET /oauth/credentials/:id — метаданные одного доступа. */
  async getOAuthCredential(id: string): Promise<ExternalCredentialMeta> {
    return fetchJSON<ExternalCredentialMeta>(
      `${BASE_URL}/oauth/credentials/${encodeURIComponent(id)}`,
    )
  },

  /**
   * POST /oauth/credentials — выдача доступа: старт (PKCE/device) или
   * завершение (код авторизации либо опрос device-flow).
   */
  async createOAuthCredential(input: OAuthCredentialCreateInput): Promise<OAuthFlowResponse> {
    return fetchJSON<OAuthFlowResponse>(`${BASE_URL}/oauth/credentials`, {
      method: 'POST',
      body: JSON.stringify(input),
    })
  },

  /** POST /oauth/credentials/:id/refresh — форсированное обновление токена. */
  async refreshOAuthCredential(id: string): Promise<{ credential: ExternalCredentialMeta }> {
    return fetchJSON<{ credential: ExternalCredentialMeta }>(
      `${BASE_URL}/oauth/credentials/${encodeURIComponent(id)}/refresh`,
      { method: 'POST' },
    )
  },

  /** DELETE /oauth/credentials/:id — отзыв доступа. */
  async deleteOAuthCredential(id: string): Promise<OAuthCredentialRevokeResult> {
    return fetchJSON<OAuthCredentialRevokeResult>(
      `${BASE_URL}/oauth/credentials/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    )
  },

  /** POST /oauth/credentials/:id/bind — привязка доступа к MCP-коннектору. */
  async bindOAuthCredential(id: string, connectorId: string): Promise<OAuthCredentialBindResult> {
    return fetchJSON<OAuthCredentialBindResult>(
      `${BASE_URL}/oauth/credentials/${encodeURIComponent(id)}/bind`,
      { method: 'POST', body: JSON.stringify({ connectorId }) },
    )
  },
}
