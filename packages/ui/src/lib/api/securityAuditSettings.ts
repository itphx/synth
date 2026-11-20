// security-audit-settings: runtime-настройки журнала **решений по правам**
// (`/api/v2/settings/audit`).
//
// Контракт (ядро: `server/routes/settings-audit.ts`):
//   GET    /api/v2/settings/audit → снимок эффективных значений секции
//   PUT    /api/v2/settings/audit { permission: { mode?, retentionDays? } } → тот же снимок
//   DELETE /api/v2/settings/audit → тот же снимок (сброс runtime)
//
// Секция описывает журнал `scope:'permission'` (записи `allow`/`deny`):
// `mode` — какие решения писать (`decisions` — только дошедшие до человека,
// `all` — все, включая автоматические по правилу), `retentionDays` — сколько
// дней записи живут. Границы значений серверные; клиентские константы ниже
// совпадают с ними (`SECURITY_AUDIT_RETENTION_DAYS_RANGE`).
//
// Приоритет эффективного значения: env `SYNTH_AUDIT_PERMISSION_*` > runtime
// (`settings.json`/PG) > дефолт (секции в `config.yaml` нет). Поле,
// зафиксированное env, из UI не перекрывается: сервер отвечает `409`
// (`ENV_LOCKED`).
//
// `PUT` принимает **вложенную** форму `{ permission: { … } }` (частичный патч:
// незаданное поле сохраняется) — тело собирается вызывающим, модуль отправляет
// его как есть, без обёрток.

import { BASE_URL, fetchJSON } from './base'

/** Источник эффективного значения (env > runtime > default). */
export type SecurityAuditSettingsSource = 'env' | 'runtime' | 'default'

/** Режим журнала решений: только вопросы человеку либо все решения по правилам. */
export const SECURITY_AUDIT_MODES = ['decisions', 'all'] as const
export type SecurityAuditMode = (typeof SECURITY_AUDIT_MODES)[number]

/** Поля секции (порядок — как в форме и в баннере env-фиксации). */
export const SECURITY_AUDIT_SETTINGS_FIELDS = ['mode', 'retentionDays'] as const
export type SecurityAuditSettingsField = (typeof SECURITY_AUDIT_SETTINGS_FIELDS)[number]

/** Границы срока хранения записей журнала решений, дни. */
export const SECURITY_AUDIT_RETENTION_DAYS_RANGE = { min: 1, max: 3650 } as const

/** Эффективные значения секции. */
export interface SecurityAuditPermissionSettings {
  mode: SecurityAuditMode
  retentionDays: number
}

/** Частичный патч секции (незаданное поле не меняется). */
export type SecurityAuditPermissionPatch = Partial<SecurityAuditPermissionSettings>

/** Тело `PUT /settings/audit` — вложенная форма контракта бэкенда. */
export interface SecurityAuditSettingsPatch {
  permission: SecurityAuditPermissionPatch
}

/** Ответ `GET/PUT/DELETE /api/v2/settings/audit`. */
export interface SecurityAuditSettings {
  /** Эффективные значения секции `audit.permission`. */
  permission: SecurityAuditPermissionSettings
  /** Источник эффективных значений — наиболее специфичный слой среди полей. */
  source: SecurityAuditSettingsSource
  /** Источник **каждого** поля. */
  sources: Record<SecurityAuditSettingsField, SecurityAuditSettingsSource>
  /** База без runtime (к чему вернёт `DELETE`). */
  defaults: SecurityAuditPermissionSettings
  /** Env зафиксировал хотя бы одно поле. */
  envLocked: boolean
  /** Поля, зафиксированные env: в UI они `disabled` и не уходят в `PUT`. */
  envLockedFields: SecurityAuditSettingsField[]
}

/** Фолбэк нормализации (значения ядра) — используется, только если сервер прислал мусор. */
export const SECURITY_AUDIT_FALLBACK: SecurityAuditPermissionSettings = {
  mode: 'decisions',
  retentionDays: 30,
}

const SOURCES: readonly SecurityAuditSettingsSource[] = ['env', 'runtime', 'default']

function isSource(value: unknown): value is SecurityAuditSettingsSource {
  return typeof value === 'string' && (SOURCES as readonly string[]).includes(value)
}

function isMode(value: unknown): value is SecurityAuditMode {
  return typeof value === 'string' && (SECURITY_AUDIT_MODES as readonly string[]).includes(value)
}

function isField(value: unknown): value is SecurityAuditSettingsField {
  return (
    typeof value === 'string' &&
    (SECURITY_AUDIT_SETTINGS_FIELDS as readonly string[]).includes(value)
  )
}

function isRetentionDays(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value)
}

function normalizeValues(raw: unknown): SecurityAuditPermissionSettings {
  const body = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    mode: isMode(body.mode) ? body.mode : SECURITY_AUDIT_FALLBACK.mode,
    retentionDays: isRetentionDays(body.retentionDays)
      ? body.retentionDays
      : SECURITY_AUDIT_FALLBACK.retentionDays,
  }
}

/** Источники по полям (неизвестные/отсутствующие берут общий `source`). */
function normalizeSources(raw: unknown, fallback: SecurityAuditSettingsSource) {
  const body = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const out = {} as Record<SecurityAuditSettingsField, SecurityAuditSettingsSource>
  for (const field of SECURITY_AUDIT_SETTINGS_FIELDS) {
    out[field] = isSource(body[field]) ? body[field] : fallback
  }
  return out
}

function normalize(raw: unknown): SecurityAuditSettings {
  const body = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const source = isSource(body.source) ? body.source : 'default'
  return {
    permission: normalizeValues(body.permission),
    source,
    sources: normalizeSources(body.sources, source),
    defaults: normalizeValues(body.defaults),
    envLocked: body.envLocked === true,
    // Неизвестные поля отбрасываются: список используется и для `disabled`,
    // и для баннера «зафиксировано env».
    envLockedFields: Array.isArray(body.envLockedFields)
      ? body.envLockedFields.filter(isField)
      : [],
  }
}

export const securityAuditSettingsApi = {
  /** GET /settings/audit — снимок эффективных настроек журнала решений. */
  async getSecurityAuditSettings(): Promise<SecurityAuditSettings> {
    const raw = await fetchJSON<Record<string, unknown>>(`${BASE_URL}/settings/audit`)
    return normalize(raw)
  },

  /** PUT /settings/audit — runtime-override вложенной формой (env-фиксация → 409). */
  async saveSecurityAuditSettings(
    patch: SecurityAuditSettingsPatch,
  ): Promise<SecurityAuditSettings> {
    const raw = await fetchJSON<Record<string, unknown>>(`${BASE_URL}/settings/audit`, {
      method: 'PUT',
      body: JSON.stringify(patch),
    })
    return normalize(raw)
  },

  /** DELETE /settings/audit — сброс runtime к env/дефолту. */
  async resetSecurityAuditSettings(): Promise<SecurityAuditSettings> {
    const raw = await fetchJSON<Record<string, unknown>>(`${BASE_URL}/settings/audit`, {
      method: 'DELETE',
    })
    return normalize(raw)
  },
}
