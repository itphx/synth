// security: домен API v2 (ADR-095) — объект `securityApi` и его DTO.

import { BASE_URL, fetchJSON } from './base'

export interface LlmGatewaySettings {
  enabled: boolean
  inputMode: 'obfuscate' | 'block'
  logPayloads?: boolean
  rateLimit: {
    userPerMinute: number
    providerPerMinute: number
  }
}

/** Паттерн детекции секретов (ADR-036): type — название, regex — source без слешей и флагов (компилируется с 'g'). */
export interface SecretPattern {
  type: string
  regex: string
}

/** Режим детекции подозрительных паттернов (защита от prompt injection). */
export type PromptInjectionMode = 'flag' | 'sanitize' | 'block'

/** Runtime-патч защиты от prompt injection (`PUT /settings/security`). */
export interface PromptInjectionSettings {
  enabled?: boolean
  mode?: PromptInjectionMode
}

/** Эффективная секция `security.promptInjection` (GET): все поля заданы. */
export interface PromptInjectionConfig {
  enabled: boolean
  mode: PromptInjectionMode
  /** Обёртка tool-контента — deployment-политика, runtime не управляет. */
  wrapContent: boolean
}

/** Поле защиты, которое может быть зафиксировано env. */
export type PromptInjectionField = 'enabled' | 'mode'

/** Источник эффективного значения защиты (env > runtime > config > default). */
export type PromptInjectionSource = 'env' | 'runtime' | 'config' | 'default'

/** Runtime-настройки секции «Безопасность» (защищённые пути, таймаут, prompt injection). */
export interface SecuritySettings {
  protectedPaths: {
    enabled: boolean
  }
  /** Глобальный дефолт таймаута подтверждения ask (мс); `null` — сброс к дефолту. */
  askTimeoutMs?: number | null
  promptInjection?: PromptInjectionSettings
}

/** Runtime-патч секции «Безопасность» в теле `PUT /settings/security`. */
export interface SecuritySettingsPatch {
  protectedPaths?: {
    enabled?: boolean
  }
  /** `null` — явный сброс runtime-значения к глобальному дефолту. */
  askTimeoutMs?: number | null
  promptInjection?: PromptInjectionSettings
}

/** Эффективные значения секции «Безопасность» в ответе GET/PUT/DELETE /settings/security. */
export interface SecuritySettingsView {
  protectedPaths: {
    enabled: boolean
  }
  askTimeoutMs: number
  promptInjection: PromptInjectionConfig
}

/** Полный ответ GET/PUT/DELETE /api/v2/settings/security. */
export interface SecuritySettingsResponse {
  security: SecuritySettingsView
  isOverridden: boolean
  defaults: SecuritySettingsView
  /** Источник эффективных `enabled`/`mode` защиты от prompt injection. */
  source: PromptInjectionSource
  /** Env зафиксировал хотя бы одно поле защиты — из UI оно недоступно (409). */
  envLocked: boolean
  /** Поля, зафиксированные env: контролы `disabled` и не уходят в `PUT`. */
  envLockedFields: PromptInjectionField[]
  /** Применяется сразу — рестарт не требуется. */
  restartRequired: boolean
}

/** Эффективная политика защищённых путей (списки строк). */
export interface ProtectedPathsPolicy {
  deniedPaths: string[]
  deniedPrefixes: string[]
  approvalPaths: string[]
  deniedCommandPrefixes: string[]
}

/** Ответ GET /api/v2/settings/protected-paths. */
export interface ProtectedPathsRaw {
  policy: ProtectedPathsPolicy
  base: ProtectedPathsPolicy
  isOverridden: boolean
}

export interface SessionSecretsResponse {
  sessionId: string
  secrets: Record<string, string>
}

export const securityApi = {
  // --- LLM Gateway (ADR-036) ---
  async getLlmGatewaySettingsInfo(): Promise<{
    settings: LlmGatewaySettings
    isOverridden: boolean
    defaults: LlmGatewaySettings
  }> {
    return fetchJSON<{ llmGateway: LlmGatewaySettings; isOverridden: boolean; defaults: LlmGatewaySettings }>(
      `${BASE_URL}/settings/llm-gateway`,
    ).then((r) => ({ settings: r.llmGateway, isOverridden: r.isOverridden, defaults: r.defaults }))
  },

  async saveLlmGatewaySettings(config: LlmGatewaySettings): Promise<LlmGatewaySettings> {
    return fetchJSON<{ llmGateway: LlmGatewaySettings }>(`${BASE_URL}/settings/llm-gateway`, {
      method: 'PUT',
      body: JSON.stringify({ llmGateway: config }),
    }).then((r) => r.llmGateway)
  },

  /** DELETE /settings/llm-gateway — сброс runtime-настроек к config.yaml-дефолту (live). */
  async resetLlmGatewaySettings(): Promise<LlmGatewaySettings> {
    return fetchJSON<{ llmGateway: LlmGatewaySettings }>(`${BASE_URL}/settings/llm-gateway`, {
      method: 'DELETE',
    }).then((r) => r.llmGateway)
  },

  // --- LLM Gateway: паттерны обфускации (ADR-036) ---
  async getGatewayPatterns(): Promise<{ patterns: SecretPattern[]; isOverridden: boolean; defaultPatterns: SecretPattern[] }> {
    return fetchJSON<{ patterns: SecretPattern[]; is_overridden: boolean; default_patterns: SecretPattern[] }>(`${BASE_URL}/gateway/patterns`).then((r) => ({
      patterns: r.patterns,
      isOverridden: r.is_overridden,
      defaultPatterns: r.default_patterns,
    }))
  },

  async saveGatewayPatterns(patterns: SecretPattern[]): Promise<{ patterns: SecretPattern[]; isOverridden: boolean; saved: boolean }> {
    return fetchJSON<{ patterns: SecretPattern[]; is_overridden: boolean; saved: boolean }>(`${BASE_URL}/gateway/patterns`, {
      method: 'PUT',
      body: JSON.stringify({ patterns }),
    }).then((r) => ({
      patterns: r.patterns,
      isOverridden: r.is_overridden,
      saved: r.saved,
    }))
  },

  async resetGatewayPatterns(): Promise<{ status: string }> {
    return fetchJSON<{ status: string }>(`${BASE_URL}/gateway/patterns`, {
      method: 'DELETE',
    })
  },

  // --- Безопасность: секция «Защищённые пути» ---
  async getSecuritySettings(): Promise<SecuritySettings> {
    return fetchJSON<{ security: SecuritySettings }>(`${BASE_URL}/settings/security`).then((r) => r.security)
  },

  /** Полный снимок секции «Безопасность»: эффективные значения + источник/env-фиксация. */
  async getSecuritySettingsInfo(): Promise<SecuritySettingsResponse> {
    return fetchJSON<SecuritySettingsResponse>(`${BASE_URL}/settings/security`)
  },

  async saveSecuritySettings(cfg: SecuritySettingsPatch): Promise<SecuritySettings> {
    return fetchJSON<{ security: SecuritySettings }>(`${BASE_URL}/settings/security`, {
      method: 'PUT',
      body: JSON.stringify({ security: cfg }),
    }).then((r) => r.security)
  },

  /** DELETE /settings/security — сброс runtime-патча prompt injection к config.yaml (live). */
  async resetSecuritySettings(): Promise<SecuritySettingsResponse> {
    return fetchJSON<SecuritySettingsResponse>(`${BASE_URL}/settings/security`, {
      method: 'DELETE',
    })
  },

  async getProtectedPaths(): Promise<ProtectedPathsRaw> {
    const r = await fetchJSON<{ policy: ProtectedPathsPolicy; base: ProtectedPathsPolicy; is_overridden: boolean }>(`${BASE_URL}/settings/protected-paths`)
    return { policy: r.policy, base: r.base, isOverridden: r.is_overridden }
  },

  async saveProtectedPaths(policy: ProtectedPathsPolicy): Promise<ProtectedPathsPolicy> {
    return fetchJSON<{ policy: ProtectedPathsPolicy }>(`${BASE_URL}/settings/protected-paths`, {
      method: 'PUT',
      body: JSON.stringify({ policy }),
    }).then((r) => r.policy)
  },

  async resetProtectedPaths(): Promise<{ status: string }> {
    return fetchJSON<{ status: string }>(`${BASE_URL}/settings/protected-paths`, {
      method: 'DELETE',
    })
  },

  /** Полная карта обфускации сессии (ADR-036): плейсхолдер → реальное значение. Доступ ADMIN/AUDITOR. */
  async getSessionSecrets(sessionId: string): Promise<SessionSecretsResponse> {
    return fetchJSON<SessionSecretsResponse>(`${BASE_URL}/sessions/${encodeURIComponent(sessionId)}/secrets`)
  },

  /** Логирование раскрытия секрета (ADR-036, тип 'revealed'). Эндпоинт может отсутствовать — fire-and-forget. */
  async auditRevealed(sessionId: string | undefined, placeholder: string): Promise<void> {
    await fetchJSON<void>(`${BASE_URL}/audit/revealed`, {
      method: 'POST',
      body: JSON.stringify({ sessionId, placeholder }),
    })
  },
}
