// maintenance: домен API v2 (ADR-095) — объект `maintenanceApi` и его DTO.
//
// ADR-091/ADR-092: admin-API обслуживания инстанса (backup/restore/doctor/migrate).
// Типы объявлены локально: бизнес-типы живут в core (`maintenance/service.ts`,
// `maintenance/doctor.ts`), но тянуть core в браузерный бандл нельзя
// (см. `packages/ui/AGENTS.md`). Восстановление — офлайн-операция: `POST /restore`
// только планирует её, применение — при следующем старте инстанса.

import type { MaintenanceAuditEntry } from '@itphx/synth-shared/types'
import { BASE_URL, fetchJSON } from './base'

export type { MaintenanceAuditEntry }

/** ADR-091: метаданные архива бэкапа (элемент `GET/POST /maintenance/backups`). */
export interface MaintenanceBackupInfo {
  /** Имя файла архива (basename). */
  name: string
  /** Абсолютный путь к архиву. */
  path: string
  /** Размер файла в байтах. */
  bytes: number
  /** Время снятия (`manifest.createdAt`). */
  createdAt: string
  /** Версия схемы данных в архиве. */
  schemaVersion: number
  /** `SYNTH_VERSION` в архиве. */
  instanceVersion: string
  /** Архив содержит `secrets/`. */
  withSecrets: boolean
  /** Архив содержит `workspaces/`. */
  withWorkspace: boolean
  /** ADR-097: backend хранения в архиве (`postgres` — данных БД внутри нет). */
  storageBackend?: string
  /** Число записей в манифесте. */
  entries: number
  /** ADR-091: архив зашифрован (`.tar.gz.enc`); метаданные — из sidecar. */
  encrypted?: boolean
  /** ADR-091: метаданные зашифрованного архива доступны (sidecar есть и валиден). */
  metadataAvailable?: boolean
}

/** ADR-091: отложенный запрос на восстановление (`{dataDir}/maintenance/restore-request.json`). */
export interface PendingRestoreRequest {
  /** Абсолютный путь к архиву (только внутри `{dataDir}/backups/`). */
  archive: string
  /** Кто запросил (для аудита; необязательно). */
  requestedBy?: string
  /** ISO-метка запроса. */
  requestedAt: string
  /** Создать страховочную копию перед восстановлением. */
  safetyCopy: boolean
}

/** ADR-092: одна миграция схемы данных. */
export interface MaintenanceMigration {
  /** Стабильный id миграции. */
  id: string
  /** Версия схемы, до которой миграция поднимает данные. */
  toVersion: number
  /** Человекочитаемое описание. */
  description: string
}

/** ADR-092: состояние схемы данных (`GET /maintenance/migrations`). */
export interface MigrationPlan {
  /** Текущая версия (`meta.json`, нет — 0). */
  current: number
  /** Ожидаемая версия (`SCHEMA_VERSION`). */
  expected: number
  /** Применённые id миграций. */
  applied: string[]
  /** Ожидающие миграции. */
  pending: MaintenanceMigration[]
}

/**
 * ADR-091/ADR-096: статус отдельной проверки `synth doctor`. `skipped` —
 * проверка неприменима к выбранному backend'у хранения (напр. файловые
 * проверки при `storage.backend=postgres`).
 */
export type DoctorStatus = 'ok' | 'warn' | 'fail' | 'skipped'

/** ADR-091: результат одной проверки инстанса. */
export interface DoctorCheck {
  /** Стабильный id проверки, напр. `data-dir`. */
  id: string
  /** Человекочитаемое название. */
  title: string
  status: DoctorStatus
  /** Подробность (факты: пути, счётчики, фактические права). */
  detail?: string
  /** Что сделать при `warn`/`fail`. */
  hint?: string
}

/** ADR-091: итог `synth doctor` (`GET /maintenance/doctor`). */
export interface DoctorResult {
  /** `false`, если хотя бы одна проверка завершилась `fail`. */
  ok: boolean
  checks: DoctorCheck[]
  dataDir: string
  /** `SYNTH_VERSION` запущенного пакета. */
  version: string
}

/** ADR-091: сводный статус обслуживания инстанса (`GET /maintenance/status`). */
export interface MaintenanceStatus {
  /** `SYNTH_VERSION` запущенного пакета. */
  version: string
  /** Каталог данных инстанса. */
  dataDir: string
  /** Состояние схемы данных (ADR-092). */
  schema: {
    current: number
    expected: number
    applied: string[]
    pending: MaintenanceMigration[]
  }
  /** Доступные архивы бэкапа. */
  backups: MaintenanceBackupInfo[]
  /** Отложенный запрос на восстановление. */
  pendingRestore: PendingRestoreRequest | null
  /** Сводка `synth doctor` (`ok` — нет `fail`). */
  doctor: { ok: boolean; fail: number; warn: number }
}

/** ADR-091: публичный снимок манифеста архива (без записей). */
export interface RestoreArchiveManifest {
  schemaVersion: number
  instanceVersion: string
  withSecrets: boolean
  withWorkspace: boolean
  /** ADR-097: backend хранения в архиве (`postgres` — данных БД внутри нет). */
  storageBackend?: string
  entries: number
  createdAt: string
}

/** ADR-091: результат проверки архива (`POST /maintenance/restore/validate`). */
export interface RestoreValidation {
  ok: boolean
  /** Причина отказа проверки (`ok: false`). */
  problem?: string
  /** Манифест архива при успешной проверке. */
  manifest?: RestoreArchiveManifest
  /** Только для multipart-загрузки: имя размещённого в `backups/uploads/` архива. */
  staged?: string
}

/** ADR-091: опции снятия архива (`POST /maintenance/backups`). */
export interface CreateBackupOptions {
  /** Включить каталог `secrets/` (архив сам становится секретом). */
  withSecrets?: boolean
  /** Включить рабочие каталоги проектов (`workspaces/`). */
  withWorkspace?: boolean
  /** Снять с работающего сервиса (срез нетранзакционный). */
  live?: boolean
}

/** ADR-092: опции выборки аудит-журнала обслуживания (`GET /maintenance/audit`). */
export interface ListAuditOptions {
  /** Вернуть последние N записей (1..500; серверный дефолт — 50). */
  limit?: number
  /** Фильтр по виду операции (напр. `backup.created`). */
  op?: string
}

/** Режим graceful restart инстанса (restart из UI). */
export type RestartMode = 'disabled' | 'process' | 'supervisor'

/** Статус graceful restart (`GET /maintenance/restart`). */
export interface RestartStatus {
  /** Рестарт доступен (режим не `disabled`). */
  supported: boolean
  mode: RestartMode
  /** Почему рестарт недоступен / что перезапускает процесс. */
  reason?: string
  /** ISO-метка старта процесса — UI ждёт её изменения после рестарта. */
  startedAt: string
  /** Версия пакета. */
  version: string
}

/** Ответ на запрос рестарта (`POST /maintenance/restart`, 202). */
export interface RestartResponse {
  status: 'restarting'
  /** `rst_<uuid>` — идентификатор запроса (в аудите). */
  restartId: string
  mode: Exclude<RestartMode, 'disabled'>
  /** ISO-метка старта текущего процесса (до рестарта). */
  startedAt: string
}

export const maintenanceApi = {
  // --- ADR-091/ADR-092: admin-API обслуживания инстанса ---
  /** GET /maintenance/status — сводный статус инстанса (схема/бэкапы/pending/doctor). */
  async getStatus(): Promise<MaintenanceStatus> {
    return fetchJSON<MaintenanceStatus>(`${BASE_URL}/maintenance/status`)
  },

  /** GET /maintenance/doctor — полный прогон проверок `synth doctor`. */
  async getDoctor(): Promise<DoctorResult> {
    return fetchJSON<DoctorResult>(`${BASE_URL}/maintenance/doctor`)
  },

  /** GET /maintenance/migrations — состояние схемы данных (ADR-092). */
  async getMigrations(): Promise<MigrationPlan> {
    return fetchJSON<MigrationPlan>(`${BASE_URL}/maintenance/migrations`)
  },

  /** POST /maintenance/migrations/apply — применить pending-миграции (`{confirm:true}`). */
  async applyMigrations(): Promise<{ applied: string[]; safetyCopyPath?: string }> {
    return fetchJSON<{ applied: string[]; safetyCopyPath?: string }>(
      `${BASE_URL}/maintenance/migrations/apply`,
      { method: 'POST', body: JSON.stringify({ confirm: true }) },
    )
  },

  /** GET /maintenance/backups — список архивов инстанса. */
  async listBackups(): Promise<{ backups: MaintenanceBackupInfo[] }> {
    return fetchJSON<{ backups: MaintenanceBackupInfo[] }>(`${BASE_URL}/maintenance/backups`)
  },

  /** POST /maintenance/backups — снять архив каталога данных. */
  async createBackup(opts: CreateBackupOptions = {}): Promise<MaintenanceBackupInfo> {
    return fetchJSON<MaintenanceBackupInfo>(`${BASE_URL}/maintenance/backups`, {
      method: 'POST',
      body: JSON.stringify({
        withSecrets: opts.withSecrets === true,
        withWorkspace: opts.withWorkspace === true,
        live: opts.live === true,
      }),
    })
  },

  /** URL скачивания архива (`GET /maintenance/backups/:name/download`). */
  backupDownloadUrl(name: string): string {
    return `${BASE_URL}/maintenance/backups/${encodeURIComponent(name)}/download`
  },

  /** DELETE /maintenance/backups/:name — удаление архива. */
  async deleteBackup(name: string): Promise<void> {
    return fetchJSON<void>(`${BASE_URL}/maintenance/backups/${encodeURIComponent(name)}`, {
      method: 'DELETE',
    })
  },

  /** POST /maintenance/restore/validate (JSON `{archive}`) — проверка архива из списка. */
  async validateRestoreByRef(archive: string): Promise<RestoreValidation> {
    return fetchJSON<RestoreValidation>(`${BASE_URL}/maintenance/restore/validate`, {
      method: 'POST',
      body: JSON.stringify({ archive }),
    })
  },

  /**
   * POST /maintenance/restore/validate (multipart) — проверка загруженного архива.
   * Свой `fetch` (не `fetchJSON`): браузер сам ставит `Content-Type` с boundary.
   */
  async validateRestoreUpload(file: File): Promise<RestoreValidation> {
    const formData = new FormData()
    formData.append('file', file)
    const response = await fetch(`${BASE_URL}/maintenance/restore/validate`, {
      method: 'POST',
      body: formData,
      credentials: 'include',
    })
    if (!response.ok) {
      const error = await response.json().catch(() => ({ detail: 'Upload failed' }))
      throw new Error(error.detail || error.error?.message || `HTTP ${response.status}`)
    }
    return response.json() as Promise<RestoreValidation>
  },

  /** GET /maintenance/restore — отложенный запрос на восстановление. */
  async getPendingRestore(): Promise<{ pending: PendingRestoreRequest | null }> {
    return fetchJSON<{ pending: PendingRestoreRequest | null }>(`${BASE_URL}/maintenance/restore`)
  },

  /** POST /maintenance/restore — спланировать восстановление (применится при следующем старте). */
  async scheduleRestore(
    archive: string,
    safetyCopy = true,
  ): Promise<{ pending: PendingRestoreRequest; appliesOnNextStart: boolean }> {
    return fetchJSON<{ pending: PendingRestoreRequest; appliesOnNextStart: boolean }>(
      `${BASE_URL}/maintenance/restore`,
      { method: 'POST', body: JSON.stringify({ archive, confirm: true, safetyCopy }) },
    )
  },

  /** DELETE /maintenance/restore — отмена отложенного запроса на восстановление. */
  async cancelRestore(): Promise<{ cancelled: boolean }> {
    return fetchJSON<{ cancelled: boolean }>(`${BASE_URL}/maintenance/restore`, {
      method: 'DELETE',
    })
  },

  // --- Restart инстанса из UI (graceful shutdown, exit 75) ---
  /** GET /maintenance/restart — статус рестарта (`supported`/`mode`/`reason`/`startedAt`). */
  async getRestartStatus(): Promise<RestartStatus> {
    return fetchJSON<RestartStatus>(`${BASE_URL}/maintenance/restart`)
  },

  /** POST /maintenance/restart — запросить graceful restart (`{confirm:true}`). */
  async restartInstance(): Promise<RestartResponse> {
    return fetchJSON<RestartResponse>(`${BASE_URL}/maintenance/restart`, {
      method: 'POST',
      body: JSON.stringify({ confirm: true }),
    })
  },

  // --- ADR-092: аудит-журнал обслуживания инстанса ---
  /** GET /maintenance/audit — последние записи журнала («свежие первыми»). */
  async listAudit(opts: ListAuditOptions = {}): Promise<{ entries: MaintenanceAuditEntry[] }> {
    const params = new URLSearchParams()
    if (opts.limit !== undefined) params.set('limit', String(opts.limit))
    if (opts.op) params.set('op', opts.op)
    const qs = params.toString()
    return fetchJSON<{ entries: MaintenanceAuditEntry[] }>(
      `${BASE_URL}/maintenance/audit${qs ? `?${qs}` : ''}`,
    )
  },

  /** DELETE /maintenance/audit — полная очистка журнала (`{confirm:true}`). */
  async clearAudit(): Promise<{ cleared: number }> {
    return fetchJSON<{ cleared: number }>(`${BASE_URL}/maintenance/audit`, {
      method: 'DELETE',
      body: JSON.stringify({ confirm: true }),
    })
  },
}
