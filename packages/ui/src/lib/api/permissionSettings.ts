// permission-settings: правила подтверждений **по умолчанию**
// (`/api/v2/settings/permissions`).
//
// Контракт (ядро: `server/routes/settings-permissions.ts`):
//   GET    /api/v2/settings/permissions → снимок эффективной карты правил
//   PUT    /api/v2/settings/permissions { rules } → тот же снимок
//   DELETE /api/v2/settings/permissions → тот же снимок (сброс runtime)
//
// Правило — действие для ключа (имя тула/группы/'*'/`external_directory`) либо
// карта «паттерн → действие» (`{ '*.env': 'deny' }`). `PUT` **заменяет карту
// целиком**: иначе снятое в UI правило «всплывало» бы из базы, поэтому тело
// всегда собирается из полной формы, а не патчем.
//
// Приоритет эффективного значения: runtime (`settings.json`/PG) > база
// (правила конфигурации инстанса) > пустая карта — env-слоя у правил нет,
// поэтому источник бывает только `runtime`/`config`/`default`.
//
// `askTimeoutMs` этой секцией **не управляется** (он в runtime-настройках
// секции «Безопасность») и приходит только как справка.

import { BASE_URL, fetchJSON } from './base'

/** Действия permission-слоя (порядок — как в форме). */
export const PERMISSION_ACTIONS = ['allow', 'deny', 'ask'] as const
export type PermissionAction = (typeof PERMISSION_ACTIONS)[number]

/** Значение правила: действие для ключа либо карта «паттерн → действие». */
export type PermissionRule = PermissionAction | Record<string, PermissionAction>

/** Источник эффективной карты правил (env-слоя у правил нет). */
export type PermissionRulesSource = 'runtime' | 'config' | 'default'

/** Ответ `GET/PUT/DELETE /api/v2/settings/permissions`. */
export interface PermissionSettingsView {
  /** Эффективная карта правил (`{}` — правил нет). */
  rules: Record<string, PermissionRule>
  /** Источник эффективной карты. */
  source: PermissionRulesSource
  /** База без runtime (к чему вернёт `DELETE`). */
  defaults: { rules: Record<string, PermissionRule> }
  /** Таймаут подтверждения `ask`, мс — только для справки. */
  askTimeoutMs: number
}

/** Тело `PUT /settings/permissions` — карта целиком. */
export interface PermissionSettingsPatch {
  rules: Record<string, PermissionRule>
}

/** Фолбэк нормализации (`DEFAULT_ASK_TIMEOUT_MS` ядра) — при мусоре в ответе. */
export const PERMISSION_ASK_TIMEOUT_FALLBACK_MS = 300_000

const SOURCES: readonly PermissionRulesSource[] = ['runtime', 'config', 'default']

function isSource(value: unknown): value is PermissionRulesSource {
  return typeof value === 'string' && (SOURCES as readonly string[]).includes(value)
}

function isAction(value: unknown): value is PermissionAction {
  return typeof value === 'string' && (PERMISSION_ACTIONS as readonly string[]).includes(value)
}

/** Карта «паттерн → действие»: мусорные пары отбрасываются. */
function normalizePatternRule(raw: Record<string, unknown>): Record<string, PermissionAction> {
  const out: Record<string, PermissionAction> = {}
  for (const [pattern, action] of Object.entries(raw)) {
    if (pattern === '' || !isAction(action)) continue
    out[pattern] = action
  }
  return out
}

/** Карта правил: невалидные значения (массивы, `null`, глубже одного уровня) — отбрасываются. */
function normalizeRules(raw: unknown): Record<string, PermissionRule> {
  const body = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<
    string,
    unknown
  >
  const out: Record<string, PermissionRule> = {}
  for (const [key, value] of Object.entries(body)) {
    if (key === '') continue
    if (isAction(value)) {
      out[key] = value
      continue
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = normalizePatternRule(value as Record<string, unknown>)
    }
  }
  return out
}

function normalizeAskTimeoutMs(raw: unknown): number {
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0
    ? Math.round(raw)
    : PERMISSION_ASK_TIMEOUT_FALLBACK_MS
}

function normalize(raw: unknown): PermissionSettingsView {
  const body = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const defaults = (body.defaults && typeof body.defaults === 'object' ? body.defaults : {}) as Record<
    string,
    unknown
  >
  return {
    rules: normalizeRules(body.rules),
    source: isSource(body.source) ? body.source : 'default',
    defaults: { rules: normalizeRules(defaults.rules) },
    askTimeoutMs: normalizeAskTimeoutMs(body.askTimeoutMs),
  }
}

export const permissionSettingsApi = {
  /** GET /settings/permissions — эффективная карта правил и её база. */
  async getPermissionSettings(): Promise<PermissionSettingsView> {
    const raw = await fetchJSON<Record<string, unknown>>(`${BASE_URL}/settings/permissions`)
    return normalize(raw)
  },

  /** PUT /settings/permissions — карта replacement-семантикой (без патча). */
  async savePermissionSettings(
    patch: PermissionSettingsPatch,
  ): Promise<PermissionSettingsView> {
    const raw = await fetchJSON<Record<string, unknown>>(`${BASE_URL}/settings/permissions`, {
      method: 'PUT',
      body: JSON.stringify({ rules: patch.rules }),
    })
    return normalize(raw)
  },

  /** DELETE /settings/permissions — сброс runtime к базе. */
  async resetPermissionSettings(): Promise<PermissionSettingsView> {
    const raw = await fetchJSON<Record<string, unknown>>(`${BASE_URL}/settings/permissions`, {
      method: 'DELETE',
    })
    return normalize(raw)
  },
}
