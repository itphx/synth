// agents-limits: instance-wide бюджет промпта саб-агента
// (`agents.subagentMaxInputTokens`). `0` — без лимита.
//
// `GET/PUT/DELETE /api/v2/settings/agents-limits`: чтение, runtime-override
// (применяется к следующим прогонам без рестарта) и сброс к env/config/default.
// При env-фиксации (`SYNTH_AGENTS_SUBAGENT_MAX_INPUT_TOKENS`) сервер отвечает 409.

import { BASE_URL, fetchJSON } from './base'

/** Источник эффективного значения (env > runtime > config > default). */
export type AgentsLimitsSource = 'env' | 'runtime' | 'config' | 'default'

export interface AgentsLimitsSettings {
  /** Эффективный бюджет (0 — без лимита). */
  subagentMaxInputTokens: number
  /** Сохранённое runtime-значение (`null` — не задано). */
  saved: number | null
  /** База без runtime/env. */
  defaults: number
  source: AgentsLimitsSource
  envLocked: boolean
  restartRequired: boolean
}

const SOURCES: readonly AgentsLimitsSource[] = ['env', 'runtime', 'config', 'default']

function isSource(value: unknown): value is AgentsLimitsSource {
  return typeof value === 'string' && (SOURCES as readonly string[]).includes(value)
}

function isLimit(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function normalize(raw: unknown): AgentsLimitsSettings {
  const body = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const value = isLimit(body.subagentMaxInputTokens) ? body.subagentMaxInputTokens : 0
  return {
    subagentMaxInputTokens: value,
    saved: isLimit(body.saved) ? body.saved : null,
    defaults: isLimit(body.defaults) ? body.defaults : 0,
    source: isSource(body.source) ? body.source : 'default',
    envLocked: body.envLocked === true,
    restartRequired: body.restartRequired === true,
  }
}

export const agentsLimitsApi = {
  async getAgentsLimits(): Promise<AgentsLimitsSettings> {
    const raw = await fetchJSON<Record<string, unknown>>(`${BASE_URL}/settings/agents-limits`)
    return normalize(raw)
  },

  async setAgentsLimits(subagentMaxInputTokens: number): Promise<AgentsLimitsSettings> {
    const raw = await fetchJSON<Record<string, unknown>>(`${BASE_URL}/settings/agents-limits`, {
      method: 'PUT',
      body: JSON.stringify({ subagentMaxInputTokens }),
    })
    return normalize(raw)
  },

  async resetAgentsLimits(): Promise<AgentsLimitsSettings> {
    const raw = await fetchJSON<Record<string, unknown>>(`${BASE_URL}/settings/agents-limits`, {
      method: 'DELETE',
    })
    return normalize(raw)
  },
}
