// Вложения сообщений: домен API v2 — runtime-настройки мультимодального ввода.
//
// ADR-115: runtime-настройки вложений (`GET/PUT/DELETE /settings/attachments`).
// Типы объявлены локально (как в соседних доменах): тянуть core в браузерный
// бандл нельзя (см. `packages/ui/AGENTS.md`).

import { BASE_URL, fetchJSON } from './base'

/** Источник эффективного значения настройки (приоритет env > runtime > config > default). */
export type AttachmentsSource = 'env' | 'runtime' | 'config' | 'default'

/** Поддерживаемые модальности вложений. */
export interface AttachmentsModalities {
  image: boolean
  pdf: boolean
  audio: boolean
  video: boolean
}

/** ADR-115: настройки мультимодального ввода (вложения сообщений). */
export interface AttachmentsSettings {
  /** Вложения включены (мастер-выключатель приёма файлов). */
  enabled: boolean
  /** Какие модальности принимаются. */
  modalities: AttachmentsModalities
  /** Предел размера одного файла, байты. */
  maxBytesPerFile: number
  /** Предел числа файлов в одном сообщении. */
  maxFilesPerMessage: number
  /** Предел суммарного объёма вложений сессии, байты. */
  maxBytesPerSession: number
  /** Срок хранения осиротевших вложений, дней (`0` — не удалять). */
  gcDays: number
  /** Несовместимые вложения сохраняются в рабочий каталог (модель получает путь). */
  workspaceFallback: boolean
  /** Белый список MIME-префиксов (например `image/`, `application/pdf`). */
  allowedMimePrefixes: string[]
}

/**
 * Ответ `GET/PUT/DELETE /settings/attachments`: сохранённое значение, дефолты,
 * источник, поля, зафиксированные env, и реально работающие значения.
 */
export interface AttachmentsSettingsInfo {
  attachments: AttachmentsSettings
  defaults: AttachmentsSettings
  /** Runtime-override присутствует (settings.json / PG). */
  isOverridden: boolean
  source: AttachmentsSource
  /** Поля, заданные через env: в UI они `disabled` и не отправляются в PUT. */
  envLocked: string[]
  /** Изменения применяются после перезапуска инстанса (для вложений — `false`). */
  restartRequired: boolean
  /** Настройки, с которыми работает запущенный процесс. */
  running: AttachmentsSettings
}

export const attachmentsApi = {
  /** GET /settings/attachments — настройки вложений, дефолты, источник, env-локи. */
  async getAttachmentsSettings(): Promise<AttachmentsSettingsInfo> {
    return fetchJSON<AttachmentsSettingsInfo>(`${BASE_URL}/settings/attachments`)
  },

  /** PUT /settings/attachments — частичное обновление (`{attachments: patch}`). */
  async updateAttachmentsSettings(
    patch: Partial<AttachmentsSettings>,
  ): Promise<AttachmentsSettingsInfo> {
    return fetchJSON<AttachmentsSettingsInfo>(`${BASE_URL}/settings/attachments`, {
      method: 'PUT',
      body: JSON.stringify({ attachments: patch }),
    })
  },

  /** DELETE /settings/attachments — сброс runtime-настройки к config.yaml-дефолту. */
  async resetAttachmentsSettings(): Promise<AttachmentsSettingsInfo> {
    return fetchJSON<AttachmentsSettingsInfo>(`${BASE_URL}/settings/attachments`, {
      method: 'DELETE',
    })
  },
}
