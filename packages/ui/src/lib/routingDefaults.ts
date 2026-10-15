/**
 * Глобальные дефолты маршрутизации (ADR-034).
 * Единая точка чтения/записи localStorage-ключа `synth-routing-defaults`.
 * Используется и в RoutingSettings (редактирование), и при создании сессии
 * (перенос глобальных дефолтов в настройки новой сессии).
 */
export const ROUTING_DEFAULTS_KEY = 'synth-routing-defaults'

export interface RoutingDefaults {
  routingEnabled: boolean
  routingStrategy: 'auto' | 'content' | 'cost' | 'content+cost'
  routingContent: {
    coding: { provider: string; model: string }
    chat: { provider: string; model: string }
    research: { provider: string; model: string }
  }
  routingEscalation: {
    enabled: boolean
    fallbackProvider: string
    fallbackModel: string
    minLength: number
  }
  routingCost: {
    enabled: boolean
    cheapProvider: string
    cheapModel: string
    maxCheapTokens: number
  }
  subagentRouting: {
    enabled: boolean
    model: string
    provider: string
  }
}

export const DEFAULT_ROUTING_DEFAULTS: RoutingDefaults = {
  routingEnabled: false,
  routingStrategy: 'auto',
  routingContent: {
    coding: { provider: '', model: '' },
    chat: { provider: '', model: '' },
    research: { provider: '', model: '' },
  },
  routingEscalation: {
    enabled: false,
    fallbackProvider: '',
    fallbackModel: '',
    minLength: 10,
  },
  routingCost: {
    enabled: false,
    cheapProvider: '',
    cheapModel: '',
    maxCheapTokens: 500,
  },
  subagentRouting: {
    enabled: false,
    model: '',
    provider: '',
  },
}

export function loadRoutingDefaults(): RoutingDefaults {
  try {
    const stored = localStorage.getItem(ROUTING_DEFAULTS_KEY)
    if (stored) {
      return { ...DEFAULT_ROUTING_DEFAULTS, ...JSON.parse(stored) }
    }
  } catch {
    // ignore
  }
  return { ...DEFAULT_ROUTING_DEFAULTS }
}

export function saveRoutingDefaults(defaults: RoutingDefaults) {
  try {
    localStorage.setItem(ROUTING_DEFAULTS_KEY, JSON.stringify(defaults))
  } catch {
    // ignore
  }
}

/**
 * Глобальные дефолты маршрутизации в формате SessionSettings ядра —
 * передаются при создании новой сессии. Формат согласован с сохранением
 * настроек в SessionSettingsTab (routingEscalation.checks и опциональные
 * поля subagentRouting).
 */
export function routingDefaultsToSettings(defaults: RoutingDefaults): Record<string, unknown> {
  return {
    routingEnabled: defaults.routingEnabled,
    routingStrategy: defaults.routingStrategy,
    routingContent: defaults.routingContent,
    routingEscalation: {
      ...defaults.routingEscalation,
      checks: ['min_length'] as const,
    },
    routingCost: defaults.routingCost,
    subagentRouting: {
      enabled: defaults.subagentRouting.enabled,
      model: defaults.subagentRouting.model || undefined,
      provider: defaults.subagentRouting.provider || undefined,
    },
  }
}
