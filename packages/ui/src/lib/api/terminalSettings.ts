// terminal-settings: runtime-настройки интерактивных терминалов
// (`/api/v2/settings/terminal`).
//
// Контракт (ядро: `server/routes/settings-terminal.ts`):
//   GET    /api/v2/settings/terminal → { enabled, autoRestore, source,
//                                        defaults: { enabled, autoRestore },
//                                        envLocked, restartRequired: false }
//   PUT    /api/v2/settings/terminal { enabled?, autoRestore? } → тот же снимок
//   DELETE /api/v2/settings/terminal → тот же снимок (сброс runtime к env/config/default)
//
// Приоритет эффективного значения: env `SYNTH_TERMINAL_ENABLED` > runtime
// (`settings.json`/PG) > config.yaml > default. При env-значении runtime
// заблокирован → сервер отвечает `409 CONFLICT` (env приоритетнее и из UI
// не перезаписывается).

import { BASE_URL, fetchJSON } from './base'

/** Источник эффективного значения (env > runtime > config > default). */
export type TerminalSettingsSource = 'env' | 'runtime' | 'config' | 'default'

export interface TerminalSettings {
  /** Мастер-выключатель терминалов инстанса. */
  enabled: boolean
  /** Автоматически восстанавливать вкладки терминалов после рестарта. */
  autoRestore: boolean
  /** Источник эффективных значений. */
  source: TerminalSettingsSource
  /** База без runtime (к чему вернёт `DELETE`). */
  defaults: { enabled: boolean; autoRestore: boolean }
  /** Значение зафиксировано env — runtime из UI не перекрывает. */
  envLocked: boolean
  /** Применяется сразу — рестарт не требуется. */
  restartRequired: boolean
}

const SOURCES: readonly TerminalSettingsSource[] = ['env', 'runtime', 'config', 'default']

function isSource(value: unknown): value is TerminalSettingsSource {
  return typeof value === 'string' && (SOURCES as readonly string[]).includes(value)
}

function isBool(value: unknown): value is boolean {
  return typeof value === 'boolean'
}

function normalize(raw: unknown): TerminalSettings {
  const body = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const defaults = (body.defaults && typeof body.defaults === 'object'
    ? body.defaults
    : {}) as Record<string, unknown>
  return {
    enabled: isBool(body.enabled) ? body.enabled : true,
    autoRestore: isBool(body.autoRestore) ? body.autoRestore : false,
    source: isSource(body.source) ? body.source : 'default',
    defaults: {
      enabled: isBool(defaults.enabled) ? defaults.enabled : true,
      autoRestore: isBool(defaults.autoRestore) ? defaults.autoRestore : false,
    },
    envLocked: body.envLocked === true,
    restartRequired: body.restartRequired === true,
  }
}

/** Тело PUT: только те поля, которые админ меняет. */
export interface TerminalSettingsPatch {
  enabled?: boolean
  autoRestore?: boolean
}

export const terminalSettingsApi = {
  /** GET /settings/terminal — снимок эффективных настроек. */
  async getTerminalSettings(): Promise<TerminalSettings> {
    const raw = await fetchJSON<Record<string, unknown>>(`${BASE_URL}/settings/terminal`)
    return normalize(raw)
  },

  /** PUT /settings/terminal — runtime-override (env-фиксация → 409). */
  async updateTerminalSettings(patch: TerminalSettingsPatch): Promise<TerminalSettings> {
    const raw = await fetchJSON<Record<string, unknown>>(`${BASE_URL}/settings/terminal`, {
      method: 'PUT',
      body: JSON.stringify(patch),
    })
    return normalize(raw)
  },

  /** DELETE /settings/terminal — сброс runtime к env/config/default. */
  async resetTerminalSettings(): Promise<TerminalSettings> {
    const raw = await fetchJSON<Record<string, unknown>>(`${BASE_URL}/settings/terminal`, {
      method: 'DELETE',
    })
    return normalize(raw)
  },
}
