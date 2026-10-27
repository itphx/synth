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

/**
 * ADR-115: семейство вложений — ключ назначения aux-модели
 * (`attachments.modalityModels`). Совпадает с ключами `modalities`.
 */
export type ModalityFamily = 'image' | 'pdf' | 'audio' | 'video'

/** Семейства вложений в каноническом порядке (как в API). */
export const MODALITY_FAMILIES: readonly ModalityFamily[] = ['image', 'pdf', 'audio', 'video']

/**
 * ADR-115: ссылка на aux-модель обработки семейства — ключ каталога
 * (`provider` + `model`), как у модели по умолчанию инстанса.
 */
export interface ModalityModelRef {
  provider: string
  model: string
}

/** Эффективные назначения aux-моделей (семейства без записи — не настроены). */
export type ModalityModels = Partial<Record<ModalityFamily, ModalityModelRef>>

/**
 * ADR-115: патч назначений — `null` снимает запись семейства
 * (`{modalityModels: {image: null}}`), отсутствие ключа оставляет базу из config.
 */
export type ModalityModelsPatch = Partial<Record<ModalityFamily, ModalityModelRef | null>>

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
  /**
   * ADR-115: модели обработки по семействам вложений. Пустая запись семейства —
   * обработка не настроена (вложение, которое модель сессии не принимает,
   * отбрасывается с путём в workspace).
   */
  modalityModels?: ModalityModels
}

/**
 * ADR-115: runtime-патч секции `attachments` (тело `PUT`). Отличается от
 * `Partial<AttachmentsSettings>` только `modalityModels`: `null` снимает
 * назначение семейства.
 */
export type AttachmentsRuntimeSettings = Omit<Partial<AttachmentsSettings>, 'modalityModels'> & {
  modalityModels?: ModalityModelsPatch
}

/**
 * Ответ `GET/PUT/DELETE /settings/attachments`: сохранённое значение, дефолты,
 * источник, поля, зафиксированные env, и реально работающие значения.
 */
export interface AttachmentsSettingsInfo {
  attachments: AttachmentsSettings
  defaults: AttachmentsSettings
  /**
   * Сохранённый runtime-патч как есть: `null` в `modalityModels` — снятое
   * назначение семейства, `{}` — runtime-значений нет. Опционален: старые
   * сборки ядра поле не отдают.
   */
  saved?: AttachmentsRuntimeSettings
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
    patch: AttachmentsRuntimeSettings,
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
