// terminal-settings: runtime-настройки интерактивных терминалов
// (`/api/v2/settings/terminal`).
//
// Контракт (ядро: `server/routes/settings-terminal.ts`):
//   GET    /api/v2/settings/terminal → снимок эффективных настроек
//   PUT    /api/v2/settings/terminal { …поля… } → тот же снимок
//   DELETE /api/v2/settings/terminal → тот же снимок (сброс runtime)
//
// Поля секции: `enabled`, `autoRestore` (общие) и `idleMinutes`,
// `maxPerProject`, `maxPerInstance`, `shell`, `auditInput` (параметры
// выполнения). Границы значений — серверные; клиентские константы ниже
// совпадают с ними (см. `TERMINAL_*_RANGE`, `TERMINAL_SHELL_PATTERN`).
//
// Приоритет эффективного значения: env `SYNTH_TERMINAL_*` > runtime
// (`settings.json`/PG) > config.yaml > default. Поле, зафиксированное env,
// из UI не перекрывается: сервер отвечает `409` (`ENV_LOCKED`).

import { BASE_URL, fetchJSON } from './base'

/** Источник эффективного значения (env > runtime > config > default). */
export type TerminalSettingsSource = 'env' | 'runtime' | 'config' | 'default'

/** Поля runtime-настроек терминалов. */
export type TerminalSettingsField =
  | 'enabled'
  | 'autoRestore'
  | 'idleMinutes'
  | 'maxPerProject'
  | 'maxPerInstance'
  | 'shell'
  | 'auditInput'

/** Канонический порядок полей (для локов, баннеров и обхода). */
export const TERMINAL_SETTINGS_FIELDS: readonly TerminalSettingsField[] = [
  'enabled',
  'autoRestore',
  'idleMinutes',
  'maxPerProject',
  'maxPerInstance',
  'shell',
  'auditInput',
]

/** Границы времени простоя до закрытия терминала, минуты. */
export const TERMINAL_IDLE_MINUTES_RANGE = { min: 30, max: 10080 } as const

/** Границы числа одновременно живых терминалов в одном проекте. */
export const TERMINAL_MAX_PER_PROJECT_RANGE = { min: 1, max: 64 } as const

/** Границы числа одновременно живых терминалов на инстансе. */
export const TERMINAL_MAX_PER_INSTANCE_RANGE = { min: 1, max: 256 } as const

/** Оболочка: имя/путь без пробелов; пусто — платформенный дефолт (zsh в managed). */
export const TERMINAL_SHELL_PATTERN = /^[A-Za-z0-9._/+-]{1,200}$/

/** База секции (к чему вернёт `DELETE` и что показывает как «дефолт»). */
export interface TerminalSettingsDefaults {
  enabled: boolean
  autoRestore: boolean
  idleMinutes: number
  maxPerProject: number
  maxPerInstance: number
  shell: string | null
  auditInput: boolean
}

/** Снимок эффективных настроек терминалов (`GET/PUT/DELETE /settings/terminal`). */
export interface TerminalSettings extends TerminalSettingsDefaults {
  /** Источник эффективных значений. */
  source: TerminalSettingsSource
  /** Источник по каждому полю (env > runtime > config > default). */
  sources: Record<TerminalSettingsField, TerminalSettingsSource>
  /** База без runtime (к чему вернёт `DELETE`). */
  defaults: TerminalSettingsDefaults
  /** Значение зафиксировано env — runtime из UI не перекрывает. */
  envLocked: boolean
  /** Поля, зафиксированные env: в UI они `disabled` и не уходят в PUT. */
  envLockedFields: TerminalSettingsField[]
  /** Применяется сразу — рестарт не требуется. */
  restartRequired: false
}

const SOURCES: readonly TerminalSettingsSource[] = ['env', 'runtime', 'config', 'default']

/** Фолбэки нормализации — используются, только если сервер прислал мусор. */
const FALLBACK: TerminalSettingsDefaults = {
  enabled: true,
  autoRestore: false,
  idleMinutes: 2880,
  maxPerProject: 8,
  maxPerInstance: 32,
  shell: null,
  auditInput: true,
}

function isSource(value: unknown): value is TerminalSettingsSource {
  return typeof value === 'string' && (SOURCES as readonly string[]).includes(value)
}

function isBool(value: unknown): value is boolean {
  return typeof value === 'boolean'
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** Оболочка: непустая строка — имя оболочки, иначе `null` (платформенный дефолт). */
function normalizeShell(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

function isField(value: unknown): value is TerminalSettingsField {
  return (
    typeof value === 'string' &&
    (TERMINAL_SETTINGS_FIELDS as readonly string[]).includes(value)
  )
}

function normalize(raw: unknown): TerminalSettings {
  const body = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const defaults = (body.defaults && typeof body.defaults === 'object'
    ? body.defaults
    : {}) as Record<string, unknown>
  const sources = (body.sources && typeof body.sources === 'object'
    ? body.sources
    : {}) as Record<string, unknown>
  const topSource = isSource(body.source) ? body.source : 'default'

  const normalizedDefaults: TerminalSettingsDefaults = {
    enabled: isBool(defaults.enabled) ? defaults.enabled : FALLBACK.enabled,
    autoRestore: isBool(defaults.autoRestore) ? defaults.autoRestore : FALLBACK.autoRestore,
    idleMinutes: isNumber(defaults.idleMinutes) ? defaults.idleMinutes : FALLBACK.idleMinutes,
    maxPerProject: isNumber(defaults.maxPerProject)
      ? defaults.maxPerProject
      : FALLBACK.maxPerProject,
    maxPerInstance: isNumber(defaults.maxPerInstance)
      ? defaults.maxPerInstance
      : FALLBACK.maxPerInstance,
    shell: 'shell' in defaults ? normalizeShell(defaults.shell) : FALLBACK.shell,
    auditInput: isBool(defaults.auditInput) ? defaults.auditInput : FALLBACK.auditInput,
  }

  const envLockedFields = Array.isArray(body.envLockedFields)
    ? body.envLockedFields.filter(isField)
    : []

  return {
    enabled: isBool(body.enabled) ? body.enabled : normalizedDefaults.enabled,
    autoRestore: isBool(body.autoRestore) ? body.autoRestore : normalizedDefaults.autoRestore,
    idleMinutes: isNumber(body.idleMinutes) ? body.idleMinutes : normalizedDefaults.idleMinutes,
    maxPerProject: isNumber(body.maxPerProject)
      ? body.maxPerProject
      : normalizedDefaults.maxPerProject,
    maxPerInstance: isNumber(body.maxPerInstance)
      ? body.maxPerInstance
      : normalizedDefaults.maxPerInstance,
    shell: 'shell' in body ? normalizeShell(body.shell) : normalizedDefaults.shell,
    auditInput: isBool(body.auditInput) ? body.auditInput : normalizedDefaults.auditInput,
    source: topSource,
    sources: {
      enabled: isSource(sources.enabled) ? sources.enabled : topSource,
      autoRestore: isSource(sources.autoRestore) ? sources.autoRestore : topSource,
      idleMinutes: isSource(sources.idleMinutes) ? sources.idleMinutes : topSource,
      maxPerProject: isSource(sources.maxPerProject) ? sources.maxPerProject : topSource,
      maxPerInstance: isSource(sources.maxPerInstance) ? sources.maxPerInstance : topSource,
      shell: isSource(sources.shell) ? sources.shell : topSource,
      auditInput: isSource(sources.auditInput) ? sources.auditInput : topSource,
    },
    defaults: normalizedDefaults,
    envLocked: body.envLocked === true,
    envLockedFields,
    restartRequired: false,
  }
}

/** Тело PUT: только те поля, которые админ меняет. */
export interface TerminalSettingsPatch {
  enabled?: boolean
  autoRestore?: boolean
  /** Время простоя до закрытия терминала, минуты (30…10080). */
  idleMinutes?: number
  /** Максимум одновременно живых терминалов в проекте (1…64). */
  maxPerProject?: number
  /** Максимум одновременно живых терминалов на инстансе (1…256). */
  maxPerInstance?: number
  /** Оболочка по умолчанию; `null` — платформенный дефолт. */
  shell?: string | null
  /** Писать ли `terminal.input` в журнал. */
  auditInput?: boolean
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
