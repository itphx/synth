// background-settings: runtime-настройки фоновой работы (единый реестр
// прогонов) — `/api/v2/settings/background`.
//
// Серверный контракт (core, `server/routes/settings-background.ts`):
//   GET    /api/v2/settings/background  → снимок эффективных значений,
//            источник по каждому полю (`sources`), сохранённый runtime-патч
//            (`saved`), база без runtime (`defaults`), env-фиксация;
//   PUT    /api/v2/settings/background  {…частичный патч…} → тот же снимок;
//            `400 VALIDATION_ERROR` — неизвестный ключ/тип/границы,
//            `409 ENV_LOCKED` с `fields` — поле зафиксировано env;
//   DELETE /api/v2/settings/background  → сброс runtime всех полей.
//
// Применяется сразу (`restartRequired: false`): реестр читает лимиты на
// каждый запуск, pruner'ы — retention на каждом тике.

import { BASE_URL, fetchJSON } from './base'

/** Поля секции (порядок — как в форме). */
export const BACKGROUND_SETTINGS_FIELDS = [
  'enabled',
  'maxSubagentsPerSession',
  'maxProcessesPerSession',
  'maxRunsPerSession',
  'logMaxBytes',
  'retentionDays',
] as const

export type BackgroundSettingsField = (typeof BACKGROUND_SETTINGS_FIELDS)[number]

/** Источник эффективного значения (env > runtime > config > default). */
export type BackgroundSettingsSource = 'env' | 'runtime' | 'config' | 'default'

/** Числовые поля секции. */
export interface BackgroundSettingsNumbers {
  /** Лимит одновременных блокирующих/фоновых саб-агентов (`0` — без лимита). */
  maxSubagentsPerSession: number
  /** Лимит одновременных фоновых процессов (`0` — без лимита). */
  maxProcessesPerSession: number
  /** Лимит одновременных фоновых прогонов (`0` — без лимита). */
  maxRunsPerSession: number
  /** Максимальный размер лога прогона, байт (`0` — без лимита). */
  logMaxBytes: number
  /** Срок хранения записей реестра, дней (`<= 0` — без ограничения). */
  retentionDays: number
}

/** Эффективные значения секции. */
export interface BackgroundSettingsValues extends BackgroundSettingsNumbers {
  /** Мастер-выключатель фоновой работы. */
  enabled: boolean
}

/** Частичный патч runtime (незаданное поле не меняется). */
export type BackgroundSettingsPatch = Partial<BackgroundSettingsValues>

/** Ответ `GET/PUT/DELETE /api/v2/settings/background`. */
export interface BackgroundSettings extends BackgroundSettingsValues {
  /** Сохранённый runtime-патч (`null` — не задан). */
  saved: BackgroundSettingsPatch | null
  /** База без runtime (к чему вернёт `DELETE`). */
  defaults: BackgroundSettingsValues
  /** Источник эффективных значений — наиболее специфичный слой среди полей. */
  source: BackgroundSettingsSource
  /** Источник **каждого** поля (старый сервер — пустой объект). */
  sources: Partial<Record<BackgroundSettingsField, BackgroundSettingsSource>>
  /** Env зафиксировал хотя бы одно поле. */
  envLocked: boolean
  /** Поля, зафиксированные env (из UI они `disabled`). */
  envLockedFields: BackgroundSettingsField[]
  /** Применяется сразу — рестарт не требуется. */
  restartRequired: boolean
}

const SOURCES: readonly BackgroundSettingsSource[] = ['env', 'runtime', 'config', 'default']

function isSource(value: unknown): value is BackgroundSettingsSource {
  return typeof value === 'string' && (SOURCES as readonly string[]).includes(value)
}

function isField(value: unknown): value is BackgroundSettingsField {
  return typeof value === 'string' && (BACKGROUND_SETTINGS_FIELDS as readonly string[]).includes(value)
}

/** Целое число ≥ 0 (лимиты и размер лога; дробное/строковое — не значение). */
function nonNegativeInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : fallback
}

/** Целое число (retention: `<= 0` — без ограничения). */
function anyInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) ? value : fallback
}

function normalizeValues(raw: unknown): BackgroundSettingsValues {
  const body = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    enabled: body.enabled === true,
    maxSubagentsPerSession: nonNegativeInt(body.maxSubagentsPerSession, 0),
    maxProcessesPerSession: nonNegativeInt(body.maxProcessesPerSession, 0),
    maxRunsPerSession: nonNegativeInt(body.maxRunsPerSession, 0),
    logMaxBytes: nonNegativeInt(body.logMaxBytes, 0),
    retentionDays: anyInt(body.retentionDays, 0),
  }
}

/** Сохранённый runtime-патч: только известные поля (`null` — патча нет). */
function normalizeSaved(raw: unknown): BackgroundSettingsPatch | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const body = raw as Record<string, unknown>
  const patch: BackgroundSettingsPatch = {}
  if (typeof body.enabled === 'boolean') patch.enabled = body.enabled
  if (typeof body.maxSubagentsPerSession === 'number') {
    patch.maxSubagentsPerSession = nonNegativeInt(body.maxSubagentsPerSession, 0)
  }
  if (typeof body.maxProcessesPerSession === 'number') {
    patch.maxProcessesPerSession = nonNegativeInt(body.maxProcessesPerSession, 0)
  }
  if (typeof body.maxRunsPerSession === 'number') {
    patch.maxRunsPerSession = nonNegativeInt(body.maxRunsPerSession, 0)
  }
  if (typeof body.logMaxBytes === 'number') {
    patch.logMaxBytes = nonNegativeInt(body.logMaxBytes, 0)
  }
  if (typeof body.retentionDays === 'number') {
    patch.retentionDays = anyInt(body.retentionDays, 0)
  }
  return Object.keys(patch).length > 0 ? patch : null
}

/** Источники по полям (неизвестные/отсутствующие — отбрасываются). */
function normalizeSources(raw: unknown): Partial<Record<BackgroundSettingsField, BackgroundSettingsSource>> {
  if (!raw || typeof raw !== 'object') return {}
  const out: Partial<Record<BackgroundSettingsField, BackgroundSettingsSource>> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (isField(key) && isSource(value)) out[key] = value
  }
  return out
}

/** Поля, зафиксированные env (неизвестные — отбрасываются). */
function normalizeLockedFields(raw: unknown): BackgroundSettingsField[] {
  if (!Array.isArray(raw)) return []
  return raw.filter(isField)
}

function normalize(raw: unknown): BackgroundSettings {
  const body = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const envLockedFields = normalizeLockedFields(body.envLockedFields)
  return {
    ...normalizeValues(body),
    saved: normalizeSaved(body.saved),
    defaults: normalizeValues(body.defaults),
    source: isSource(body.source) ? body.source : 'default',
    sources: normalizeSources(body.sources),
    // Старый сервер без списка полей фиксирует всё (fail-closed) — UI это
    // трактует так же, как `TerminalAdminSettings`.
    envLocked: body.envLocked === true,
    envLockedFields,
    restartRequired: body.restartRequired === true,
  }
}

export const backgroundSettingsApi = {
  async getBackgroundSettings(): Promise<BackgroundSettings> {
    const raw = await fetchJSON<Record<string, unknown>>(`${BASE_URL}/settings/background`)
    return normalize(raw)
  },

  /** PUT — частичный патч: незаданные поля сохраняются на сервере. */
  async updateBackgroundSettings(patch: BackgroundSettingsPatch): Promise<BackgroundSettings> {
    const raw = await fetchJSON<Record<string, unknown>>(`${BASE_URL}/settings/background`, {
      method: 'PUT',
      body: JSON.stringify(patch),
    })
    return normalize(raw)
  },

  async resetBackgroundSettings(): Promise<BackgroundSettings> {
    const raw = await fetchJSON<Record<string, unknown>>(`${BASE_URL}/settings/background`, {
      method: 'DELETE',
    })
    return normalize(raw)
  },
}
