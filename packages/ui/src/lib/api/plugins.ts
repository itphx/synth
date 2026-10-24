// plugins: домен API v2 (ADR-095) — слой плагинов (ADR-090, Ф6).
//
// HTTP-контур `packages/core/src/server/routes/plugins.ts`:
//   GET    /plugins                — установленные + статус активации;
//   GET    /plugins/audit          — журнал действий плагинов (хвост);
//   GET    /plugins/:name          — запись + манифест + PLUGIN_INTEGRITY.json;
//   POST   /plugins/install        — установка (201) либо карантин (202);
//   POST   /plugins/:name/approve  — подтверждение карантина;
//   POST   /plugins/:name/enable   — активация;
//   POST   /plugins/:name/disable  — деактивация;
//   POST   /plugins/update         — обновление из источника записи lock;
//   POST   /plugins/:name/rollback — откат на ступень `previous`;
//   DELETE /plugins/:name          — снятие (управляемый плагин → 403);
//   GET/PUT/DELETE /settings/plugins — runtime-настройки слоя.
//
// Типы объявлены локально (как в соседних доменах): тянуть core в браузерный
// бандл нельзя (см. `packages/ui/AGENTS.md`).
//
// Ошибки — как у всех доменов: `fetchJSON` бросает `Error` с `status` и `code`
// из `{error:{code,message}}`, поэтому вызывающий видит и текст ответа
// (`err.message`), и машиночитаемую причину (`err.code` — `plugin.*`,
// `LOCAL_INSTALL_DISABLED`, `VALIDATION_ERROR`).

import { BASE_URL, fetchJSON } from './base'

/** Уровень доверия расширения (PROP-068 §4.1, локальная копия `CATALOG_TRUST_LEVELS`). */
export type PluginTrustLevel = 'builtin' | 'verified' | 'trusted' | 'community'

/** Вердикт статического сканера бандла. */
export type PluginScanVerdict = 'safe' | 'caution' | 'dangerous'

/** Режим исполнения плагина из манифеста (`inline`/`remote`/`both`). */
export type PluginExecutionMode = 'inline' | 'remote' | 'both'

/**
 * Статус проверки плагина сервером в гибридном режиме (ADR-090 Ф7).
 *
 * - `allowed` — сервер подтвердил (политика `off` либо плагин в allow-list);
 * - `denied` — сервер запретил (плагина нет в allow-list при `allowlist`);
 * - `unverified` — сервер недоступен или политика неизвестна: локальный плагин
 *   работает в режиме cooperative, но сервер его не подтвердил.
 */
export type PluginServerPolicyStatus = 'unverified' | 'allowed' | 'denied'

/** Вид источника установки (`POST /plugins/install`). */
export type PluginInstallSourceKind = 'dir' | 'archive' | 'npm' | 'url'

/**
 * Установленный плагин + статус активации (`GET /plugins`).
 *
 * Поля совпадают с `PluginRuntimeEntry` core; `source === 'deploy'` —
 * плагин поставлен образом/PVC (management-плагин, снимать нельзя).
 */
export interface PluginRuntimeEntry {
  name: string
  version: string
  /** Метка источника в lock: `local` / `npm` / `url` / `deploy` / … */
  source: string
  trustLevel: PluginTrustLevel
  scanVerdict: PluginScanVerdict
  /** Content-hash бандла (в карточке показывается первые символы). */
  contentHash: string
  /** Точка входа бандла (если записана в lock). */
  entry?: string
  installedAt: string
  updatedAt: string
  /** Плагин активен в процессе инстанса. */
  active: boolean
  /** Фактический режим исполнения (если активен). */
  mode?: PluginExecutionMode
  /**
   * Статус проверки сервером в гибридном режиме (ADR-090 Ф7).
   *
   * `unverified` — сервер недоступен или политика неизвестна: плагин работает
   * в режиме cooperative (сервер его не подтвердил).
   */
  serverPolicy: PluginServerPolicyStatus
}

/** Ответ `GET /plugins`. */
export interface PluginsListResponse {
  plugins: PluginRuntimeEntry[]
}

/**
 * Вид операции в журнале действий плагинов (ADR-090).
 *
 * Порядок — жизненный цикл расширения: установка → активация → деактивация →
 * откат → снятие, затем диагностические `scan`/`filter` и выдача `token`.
 */
export type PluginAuditAction =
  | 'install'
  | 'activate'
  | 'deactivate'
  | 'rollback'
  | 'uninstall'
  | 'scan'
  | 'filter'
  | 'token'

/** Итог операции журнала плагинов: `ok` — состояние достигнуто, `rejected` — отказ. */
export type PluginAuditOutcome = 'ok' | 'rejected'

/**
 * Запись журнала действий плагинов (`GET /plugins/audit`).
 *
 * Журнал append-only; по времени — ISO-8601, записи отдаются «свежие
 * первыми». `reason` — машиночитаемый код отказа (`plugin.*`,
 * `plugin_filter.*`), он же объясняет, **почему** плагин не прошёл гейт.
 */
export interface PluginAuditEntry {
  id: string
  /** Метка события, ISO-8601. */
  ts: string
  /** Инициатор операции (`userId`, `cli`, `startup`, `system`). */
  actor: string
  action: PluginAuditAction
  /** Имя плагина. */
  plugin: string
  /** Версия плагина. */
  version: string
  outcome: PluginAuditOutcome
  /** Код причины (машиночитаемый). */
  reason?: string
  /** Фактический уровень доверия. */
  trustLevel?: PluginTrustLevel
  /** Вердикт статического сканера. */
  scanVerdict?: PluginScanVerdict
  /** Число находок сканера. */
  scanFindings?: number
  /** Выполнялся ли скан. */
  scanPerformed?: boolean
  /** Content-hash бандла. */
  contentHash?: string
  /** Режим исполнения (`inline`/`remote`/`both`). */
  mode?: PluginExecutionMode
  /** Источник установки. */
  source?: string
}

/** Ответ `GET /plugins/audit` — хвост журнала (последние записи). */
export interface PluginAuditListResponse {
  entries: PluginAuditEntry[]
}

/** Параметры выборки журнала плагинов (`GET /plugins/audit`). */
export interface PluginAuditListOptions {
  /** Сколько последних записей (по умолчанию 50, максимум 500 — на сервере). */
  limit?: number
  /** Фильтр по имени плагина. */
  plugin?: string
}

/** Ответ `GET /plugins/:name` — запись lock, манифест и служебный файл целостности. */
export interface PluginDetailResponse {
  plugin: PluginRuntimeEntry
  manifest?: Record<string, unknown>
  integrity?: Record<string, unknown>
}

/** Итог активации/деактивации (`enable`/`disable`). */
export interface PluginActivationSummary {
  outcome: string
  reason?: string
  message?: string
  mode?: PluginExecutionMode
}

/** Ответ `POST /plugins/:name/enable` и `.../disable`. */
export interface PluginActivationResponse {
  activation?: PluginActivationSummary
  deactivation?: PluginActivationSummary
}

/** Тело `POST /plugins/install` (вид источника выводит сервер по заполненному полю). */
export interface PluginInstallInput {
  source?: PluginInstallSourceKind
  /** Каталог или `.tgz`/`.tar.gz` (`dir`/`archive`). */
  path?: string
  /** npm-имя пакета (`name` или `@scope/name`). */
  name?: string
  /** Точная версия npm-пакета (по умолчанию `latest`). */
  version?: string
  /** https-адрес архива (`url`). */
  url?: string
  /** Пин архива для `url` (64 hex-символа) — обязателен. */
  sha256?: string
  /** Уровень доверия установки (по умолчанию `community`). */
  trustLevel?: PluginTrustLevel
}

/**
 * Итог установки: `installed` (201) либо `approval_required` (202 — бандл ушёл
 * в карантин и ждёт подтверждения администратора).
 */
export interface PluginInstallResult {
  outcome: 'installed' | 'approval_required'
  name: string
  version: string
  /** Причина карантина (`plugin.approval_required`). */
  reason?: string
  dir?: string
  contentHash?: string
  activated?: PluginActivationSummary
}

/** Тело `POST /plugins/update` (источник берётся из записи lock). */
export interface PluginUpdateInput {
  name: string
  /** Только для npm-источника: точная версия или `latest`. */
  version?: string
  /** Только для `url`: новый пин архива (64 hex). */
  sha256?: string
  activate?: boolean
}

/** Итог обновления: `unchanged` — бандл совпал по content-hash. */
export type PluginUpdateResult =
  | { outcome: 'unchanged'; name: string; version: string; contentHash: string }
  | {
      outcome: 'updated'
      name: string
      version: string
      previousVersion: string
      dir?: string
      contentHash?: string
      activated?: PluginActivationSummary
    }

/** Итог отката на ступень `previous` (swap — откат обратим). */
export interface PluginRollbackResult {
  outcome: 'rolled_back'
  name: string
  version: string
  previousVersion: string
  activated?: PluginActivationSummary
}

/** Отслеживаемые UI ключи политики слоя плагинов (`/settings/plugins`). */
export interface PluginsPolicyValues {
  enabled: boolean
  executionEnabled: boolean
  runtimeInstall: 'allow' | 'deny'
  trustFloor: PluginTrustLevel
  scan: 'enabled' | 'disabled'
  /** Бюджет символов на блок системного промпта от плагина. */
  promptBlockMaxChars: number
  /** Бюджет времени на вызов фильтра LLM-вызовов, мс. */
  llmFilterTimeoutMs: number
}

/** Ответ `GET/PUT/DELETE /settings/plugins`. */
export interface PluginsSettingsInfo {
  /** Runtime-override (может быть частичным). */
  plugins: Partial<PluginsPolicyValues>
  /** Дефолты из config.yaml (полный набор ключей секции). */
  defaults: PluginsPolicyValues
  /** Runtime-override присутствует (`settings.json`/PG). */
  isOverridden: boolean
  /**
   * Изменения применяются после перезапуска инстанса (инвариант 24: рантайм
   * плагинов и хост собираются при старте).
   */
  restartRequired: boolean
  /** Эффективные значения процесса на момент старта. */
  running: PluginsPolicyValues
  /**
   * Серверная политика плагинов в гибридном режиме (ADR-090 Ф7).
   *
   * `mode: 'off'` — сервер не ограничивает плагины; `mode: 'allowlist'` —
   * разрешены только плагины из `allow` (список приходит только в этом режиме).
   */
  hybrid?: { mode: 'off' | 'allowlist'; allow: string[] }
}

/** Патч политики (`PUT /settings/plugins`) — частичный набор ключей. */
export type PluginsPolicyPatch = Partial<PluginsPolicyValues>

const pluginPath = (name: string): string =>
  `${BASE_URL}/plugins/${encodeURIComponent(name)}`

export const pluginsApi = {
  // --- ADR-090 Ф6: жизненный цикл плагинов (`/plugins*`) ---
  /** GET /plugins — установленные плагины и статус активации. */
  async listPlugins(): Promise<PluginRuntimeEntry[]> {
    const response = await fetchJSON<PluginsListResponse>(`${BASE_URL}/plugins`)
    return response.plugins ?? []
  },

  /**
   * GET /plugins/audit — журнал действий плагинов (ADR-090).
   *
   * Журнал append-only и может быть большим, поэтому сервер отдаёт **хвост**:
   * `limit` (по умолчанию 50, максимум 500) и необязательный фильтр по имени
   * плагина (`plugin`). Записи «свежие первыми».
   */
  async listPluginAudit(opts: PluginAuditListOptions = {}): Promise<PluginAuditEntry[]> {
    const params = new URLSearchParams()
    if (opts.limit !== undefined) params.set('limit', String(opts.limit))
    if (opts.plugin) params.set('plugin', opts.plugin)
    const query = params.toString()
    const response = await fetchJSON<PluginAuditListResponse>(
      `${BASE_URL}/plugins/audit${query ? `?${query}` : ''}`,
    )
    return response.entries ?? []
  },

  /** GET /plugins/:name — деталь: запись lock, манифест, целостность. */
  async getPlugin(name: string): Promise<PluginDetailResponse> {
    return fetchJSON<PluginDetailResponse>(pluginPath(name))
  },

  /**
   * POST /plugins/install — установка из источника.
   *
   * `202` не ошибка: результат приходит как `{outcome:'approval_required'}`
   * (бандл в карантине, нужно подтверждение). `403 LOCAL_INSTALL_DISABLED`
   * (managed) и прочие отказы — исключением с `code`.
   */
  async installPlugin(input: PluginInstallInput): Promise<PluginInstallResult> {
    return fetchJSON<PluginInstallResult>(`${BASE_URL}/plugins/install`, {
      method: 'POST',
      body: JSON.stringify(input),
    })
  },

  /** POST /plugins/:name/approve — подтверждение бандла из карантина (только ADMIN). */
  async approvePlugin(name: string): Promise<PluginInstallResult> {
    return fetchJSON<PluginInstallResult>(`${pluginPath(name)}/approve`, { method: 'POST' })
  },

  /** POST /plugins/:name/enable — активация (гейты доверия/скана/исполнения). */
  async enablePlugin(name: string): Promise<PluginActivationResponse> {
    return fetchJSON<PluginActivationResponse>(`${pluginPath(name)}/enable`, { method: 'POST' })
  },

  /** POST /plugins/:name/disable — деактивация (обратная прокрутка disposers). */
  async disablePlugin(name: string): Promise<PluginActivationResponse> {
    return fetchJSON<PluginActivationResponse>(`${pluginPath(name)}/disable`, { method: 'POST' })
  },

  /** DELETE /plugins/:name — снятие по записи lock (управляемый → 403 `plugin.managed_readonly`). */
  async removePlugin(name: string): Promise<void> {
    await fetchJSON<void>(pluginPath(name), { method: 'DELETE' })
  },

  /** POST /plugins/update — обновление из источника записи lock. */
  async updatePlugin(input: PluginUpdateInput): Promise<PluginUpdateResult> {
    return fetchJSON<PluginUpdateResult>(`${BASE_URL}/plugins/update`, {
      method: 'POST',
      body: JSON.stringify(input),
    })
  },

  /** POST /plugins/:name/rollback — откат на предыдущую версию (`409`, если ступени нет). */
  async rollbackPlugin(name: string): Promise<PluginRollbackResult> {
    return fetchJSON<PluginRollbackResult>(`${pluginPath(name)}/rollback`, { method: 'POST' })
  },

  // --- ADR-090: runtime-настройки слоя (`/settings/plugins`) ---
  /** GET /settings/plugins — runtime-override, дефолты, признак рестарта. */
  async getPluginsSettings(): Promise<PluginsSettingsInfo> {
    return fetchJSON<PluginsSettingsInfo>(`${BASE_URL}/settings/plugins`)
  },

  /** PUT /settings/plugins — частичный патч политики слоя (применяется рестартом). */
  async updatePluginsSettings(patch: PluginsPolicyPatch): Promise<PluginsSettingsInfo> {
    return fetchJSON<PluginsSettingsInfo>(`${BASE_URL}/settings/plugins`, {
      method: 'PUT',
      body: JSON.stringify(patch),
    })
  },

  /** DELETE /settings/plugins — сброс runtime-настроек к config.yaml-дефолтам. */
  async resetPluginsSettings(): Promise<PluginsSettingsInfo> {
    return fetchJSON<PluginsSettingsInfo>(`${BASE_URL}/settings/plugins`, { method: 'DELETE' })
  },
}
