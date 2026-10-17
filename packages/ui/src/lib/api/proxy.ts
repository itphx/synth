// proxy: домен API v2 (ADR-095, ADR-099 D1) — egress-прокси (read-only).
//
// Статус настройки применяется при старте процесса (`restartRequired: true`);
// URL отдаётся redacted (без кред). Проверка — коннект к самому прокси, не к цели.

import type { EgressProxyStatus, ProxyCheckResult } from '@itphx/synth-shared'
import { BASE_URL, fetchJSON } from './base'

export type { EgressProxyStatus, ProxyCheckResult }

export const proxyApi = {
  /** GET /settings/proxy — эффективный статус прокси (read-only, без секретов). */
  async getProxyStatus(): Promise<EgressProxyStatus> {
    return fetchJSON<EgressProxyStatus>(`${BASE_URL}/settings/proxy`)
  },

  /**
   * POST /settings/proxy/check — проверка соединения с прокси (ADMIN):
   * TCP-connect + распознавание `Proxy-Authenticate` (Basic/NTLM/Negotiate).
   * Цель при этом не запрашивается.
   */
  async checkProxy(): Promise<ProxyCheckResult> {
    return fetchJSON<ProxyCheckResult>(`${BASE_URL}/settings/proxy/check`, {
      method: 'POST',
      body: JSON.stringify({}),
    })
  },
}
