import { useCallback, useEffect, useMemo, useState } from 'react'

import { useI18n } from '@/lib/i18n'
import { useNotification } from '@/hooks/useNotification'
import { useEnsureModelsLoaded } from '@/hooks/useEnsureModelsLoaded'
import { cn } from '@/lib/utils'
import {
  MODALITY_FAMILIES,
  synthApi,
  type AttachmentsRuntimeSettings,
  type AttachmentsSettings,
  type AttachmentsSettingsInfo,
  type ModelInfo,
  type ModalityFamily,
  type ModalityModelRef,
} from '@/lib/api/synthApi'
import { useCatalogModels } from '@/hooks/useCatalogModels'
import { useProvidersStore } from '@/stores/providersStore'
import { isSelectableModel, selectableProvidersByName } from '@/lib/modelOptions'
import { Icon } from '../icon/Icon'
import { SelectContent, SelectItem } from '../ui/select'
import {
  InfoField,
  NumberField,
  SelectField,
  SettingsActions,
  SettingsPanel,
  SettingsSection,
  TextField,
  ToggleField,
  useSettingsDraft,
} from '../ui/settings'

/** Байт в MiB: 1024-основание (как в UI-лимитах вложений). */
export const MIB_BYTES = 1024 * 1024

/** Бейдж состояния (источник/переопределение) — общий вид с админкой «Метрики». */
const BADGE = 'rounded px-1.5 py-0.5 text-[0.625rem] font-medium'

/** Цвет бейджа источника настройки. */
const SOURCE_BADGE_CLASS: Record<AttachmentsSettingsInfo['source'], string> = {
  env: 'bg-status-warning/15 text-status-warning',
  runtime: 'bg-primary/15 text-primary',
  config: 'bg-muted text-muted-foreground',
  default: 'bg-muted text-muted-foreground',
}

/** Поля секции `attachments` — env-локи проверяются по этому списку. */
const ATTACHMENTS_FIELDS = [
  'enabled',
  'modalities',
  'maxBytesPerFile',
  'maxFilesPerMessage',
  'maxBytesPerSession',
  'gcDays',
  'workspaceFallback',
  'allowedMimePrefixes',
  'modalityModels',
  'compression',
  'thumbnail',
  'maxChunkBytes',
  'maxActiveUploadsPerSession',
  'maxActiveUploads',
] as const

/** Значение select строки «модель по модальности», когда назначения нет. */
export const NOT_SET_MODALITY_MODEL = '__none__'

/** Значения aux-моделей по семействам в черновике формы (`null` — не задано). */
export type ModalityModelForm = Record<ModalityFamily, ModalityModelRef | null>

/** Модель каталога, принимающая модальность, — вариант select'а строки. */
export interface ModalityModelOption {
  /** Значение select'а: устойчивый ключ пары (`provider/model`). */
  key: string
  ref: ModalityModelRef
  label: string
}

/** Ключ пары provider+model (провайдер без `/`, поэтому ключ однозначен). */
export function modalityModelKey(ref: ModalityModelRef): string {
  return `${ref.provider}/${ref.model}`
}

/**
 * Модели каталога, у которых `modalities` содержит семейство (ADR-115).
 *
 * Модели без известных модальностей не предлагаются: сервер всё равно отклонит
 * такую aux-модель — нельзя проверить, принимает ли она формат.
 */
export function modelsForModality(
  models: ReadonlyArray<Pick<ModelInfo, 'name' | 'provider' | 'modalities'>>,
  family: ModalityFamily,
): ModalityModelOption[] {
  const options: ModalityModelOption[] = []
  for (const model of models) {
    if (!Array.isArray(model.modalities) || !model.modalities.includes(family)) continue
    const ref: ModalityModelRef = { provider: model.provider, model: model.name }
    options.push({ key: modalityModelKey(ref), ref, label: `${model.provider} / ${model.name}` })
  }
  return options
}

/** Назначения из настроек → черновик (все четыре семейства, `null` — не задано). */
export function modalityModelsForm(
  settings: Pick<AttachmentsSettings, 'modalityModels'>,
): ModalityModelForm {
  const source = settings.modalityModels ?? {}
  const form = {} as ModalityModelForm
  for (const family of MODALITY_FAMILIES) {
    const ref = source[family]
    form[family] = ref ? { provider: ref.provider, model: ref.model } : null
  }
  return form
}

/** Черновик назначений → тело PUT (все ключи; пустое — `null` = снять запись). */
function modalityModelsBody(
  form: ModalityModelForm,
): Record<ModalityFamily, ModalityModelRef | null> {
  const body = {} as Record<ModalityFamily, ModalityModelRef | null>
  for (const family of MODALITY_FAMILIES) {
    const ref = form[family]
    body[family] = ref ? { provider: ref.provider, model: ref.model } : null
  }
  return body
}

/**
 * Черновик формы (ADR-072): числа — строками, чтобы пользователь мог стереть
 * значение и ввести новое, а MIME-список — одной строкой через запятую.
 */
export interface AttachmentsForm {
  enabled: boolean
  image: boolean
  pdf: boolean
  audio: boolean
  video: boolean
  /** Максимум на файл, MiB (целое). */
  maxFileMiB: string
  /** Файлов в сообщении. */
  maxFilesPerMessage: string
  /** Лимит на сессию, MiB. */
  maxSessionMiB: string
  /** Срок хранения осиротевших вложений, дней (`0` — не удалять). */
  gcDays: string
  workspaceFallback: boolean
  /** Белый список MIME-префиксов одной строкой через запятую. */
  mimePrefixes: string
  /** ADR-115: aux-модели по семействам вложений (`null` — не задана). */
  modalityModels: ModalityModelForm
  /** ADR-115: мастер-выключатель сжатия перед отправкой модели. */
  compressionEnabled: boolean
  imageCompressionEnabled: boolean
  /** Предел длинной стороны изображения, px. */
  imageMaxSide: string
  /** Качество JPEG/WebP, 1..100. */
  imageQuality: string
  /** Порог сжатия изображения, MiB. */
  imageMinMiB: string
  videoCompressionEnabled: boolean
  /** Предел высоты кадра видео, px. */
  videoMaxHeight: string
  /** Битрейт видео, кбит/с. */
  videoBitrateKbps: string
  /** Битрейт звуковой дорожки видео, кбит/с. */
  videoAudioBitrateKbps: string
  /** Порог перекодирования видео, MiB. */
  videoMinMiB: string
  audioCompressionEnabled: boolean
  /** Битрейт аудио, кбит/с. */
  audioBitrateKbps: string
  /** Каналы аудио, 1..2. */
  audioChannels: string
  /** Частота дискретизации аудио, Гц. */
  audioSampleRate: string
  /** Порог сжатия аудио, MiB. */
  audioMinMiB: string
  /** ADR-115: генерация серверных миниатюр. */
  thumbnailEnabled: boolean
  /** Предел ширины миниатюры, px. */
  thumbnailMaxWidth: string
  /** ADR-115: размер части chunked-загрузки, MiB. */
  maxChunkMiB: string
  /** ADR-115: предел одновременных chunked-загрузок одной сессии. */
  maxActiveUploadsPerSession: string
  /** ADR-115: общий предел активных chunked-загрузок инстанса. */
  maxActiveUploads: string
}

/** Байты → MiB для поля ввода: до 2 знаков, без лишних нулей. */
export function bytesToMiB(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0'
  return String(Number((bytes / MIB_BYTES).toFixed(2)))
}

/** MiB из поля ввода → байты; `null` — значение не число. */
export function mibToBytes(value: string): number | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  const parsed = Number(trimmed)
  if (!Number.isFinite(parsed) || parsed < 0) return null
  return Math.round(parsed * MIB_BYTES)
}

/** Целое неотрицательное из поля ввода; `null` — не число/не целое/отрицательное. */
function parseIntField(value: string): number | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  const parsed = Number(trimmed)
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) return null
  return parsed
}

/**
 * Число из черновика: неизменённое поле берётся из сохранённых настроек
 * (без потери точности округления MiB/строкового представления).
 */
function intFromDraft(draft: string, saved: string, savedValue: number): number {
  if (draft === saved) return savedValue
  return parseIntField(draft) ?? savedValue
}

/** Байты из MiB-черновика: неизменённое поле — точное сохранённое значение. */
function mibFromDraft(draft: string, saved: string, savedValue: number): number {
  if (draft === saved) return savedValue
  return mibToBytes(draft) ?? savedValue
}

/** MIME-список из строки: пустые элементы отбрасываются. */
export function parseMimePrefixes(text: string): { values: string[]; hasEmpty: boolean } {
  const parts = text.split(',')
  const values: string[] = []
  let hasEmpty = false
  for (const part of parts) {
    const trimmed = part.trim()
    if (trimmed) values.push(trimmed)
    else hasEmpty = true
  }
  // Пустая строка целиком — не ошибка: список просто не задан.
  if (!text.trim()) hasEmpty = false
  return { values, hasEmpty }
}

/** MIME-список → строка для поля ввода. */
export function formatMimePrefixes(values: string[]): string {
  return values.join(', ')
}

/** Настройки сервера → черновик формы. */
export function formFromAttachments(settings: AttachmentsSettings): AttachmentsForm {
  return {
    enabled: settings.enabled,
    image: settings.modalities.image,
    pdf: settings.modalities.pdf,
    audio: settings.modalities.audio,
    video: settings.modalities.video,
    maxFileMiB: bytesToMiB(settings.maxBytesPerFile),
    maxFilesPerMessage: String(settings.maxFilesPerMessage),
    maxSessionMiB: bytesToMiB(settings.maxBytesPerSession),
    gcDays: String(settings.gcDays),
    workspaceFallback: settings.workspaceFallback,
    mimePrefixes: formatMimePrefixes(settings.allowedMimePrefixes),
    modalityModels: modalityModelsForm(settings),
    compressionEnabled: settings.compression.enabled,
    imageCompressionEnabled: settings.compression.image.enabled,
    imageMaxSide: String(settings.compression.image.maxSidePx),
    imageQuality: String(settings.compression.image.quality),
    imageMinMiB: bytesToMiB(settings.compression.image.minBytes),
    videoCompressionEnabled: settings.compression.video.enabled,
    videoMaxHeight: String(settings.compression.video.maxHeightPx),
    videoBitrateKbps: String(settings.compression.video.bitrateKbps),
    videoAudioBitrateKbps: String(settings.compression.video.audioBitrateKbps),
    videoMinMiB: bytesToMiB(settings.compression.video.minBytes),
    audioCompressionEnabled: settings.compression.audio.enabled,
    audioBitrateKbps: String(settings.compression.audio.bitrateKbps),
    audioChannels: String(settings.compression.audio.channels),
    audioSampleRate: String(settings.compression.audio.sampleRateHz),
    audioMinMiB: bytesToMiB(settings.compression.audio.minBytes),
    thumbnailEnabled: settings.thumbnail.enabled,
    thumbnailMaxWidth: String(settings.thumbnail.maxWidthPx),
    maxChunkMiB: bytesToMiB(settings.maxChunkBytes),
    maxActiveUploadsPerSession: String(settings.maxActiveUploadsPerSession),
    maxActiveUploads: String(settings.maxActiveUploads),
  }
}

/**
 * Поле зафиксировано env? Поддерживаем и точечные имена (`modalities.image`),
 * и групповые (`modalities` — блокирует все модальности).
 */
export function isEnvLockedField(envLocked: readonly string[], field: string): boolean {
  return envLocked.some((locked) => locked === field || field.startsWith(`${locked}.`))
}

/**
 * Тело PUT: полный набор настроек без env-зафиксированных полей.
 *
 * Порядок в API заменяет runtime-секцию целиком (не мержит), поэтому отправляем
 * все поля: неизменённые берутся из сохранённых настроек (байты без потерь от
 * пересчёта MiB), изменённые — из черновика. Поля из `envLocked` не отправляются:
 * значение задано через env и переопределяется только там (иначе сервер вернёт 409).
 *
 * `modalityModels` (ADR-115) уходит целиком — все четыре ключа, `null` для
 * снятых назначений: патч заменяет runtime-секцию назначений, поэтому иначе
 * сервер сохранил бы прежние записи семейств.
 */
export function buildAttachmentsBody(
  draft: AttachmentsForm,
  saved: AttachmentsForm,
  savedSettings: AttachmentsSettings,
  envLocked: readonly string[] = [],
): AttachmentsRuntimeSettings {
  const body: AttachmentsRuntimeSettings = {
    enabled: draft.enabled,
    modalities: {
      image: draft.image,
      pdf: draft.pdf,
      audio: draft.audio,
      video: draft.video,
    },
    maxBytesPerFile:
      draft.maxFileMiB === saved.maxFileMiB
        ? savedSettings.maxBytesPerFile
        : (mibToBytes(draft.maxFileMiB) ?? savedSettings.maxBytesPerFile),
    maxFilesPerMessage:
      draft.maxFilesPerMessage === saved.maxFilesPerMessage
        ? savedSettings.maxFilesPerMessage
        : (parseIntField(draft.maxFilesPerMessage) ?? savedSettings.maxFilesPerMessage),
    maxBytesPerSession:
      draft.maxSessionMiB === saved.maxSessionMiB
        ? savedSettings.maxBytesPerSession
        : (mibToBytes(draft.maxSessionMiB) ?? savedSettings.maxBytesPerSession),
    gcDays:
      draft.gcDays === saved.gcDays
        ? savedSettings.gcDays
        : (parseIntField(draft.gcDays) ?? savedSettings.gcDays),
    workspaceFallback: draft.workspaceFallback,
    allowedMimePrefixes:
      draft.mimePrefixes === saved.mimePrefixes
        ? [...savedSettings.allowedMimePrefixes]
        : parseMimePrefixes(draft.mimePrefixes).values,
    modalityModels: modalityModelsBody(draft.modalityModels),
  }

  // ADR-115: сжатие и миниатюры отправляются **полными** объектами (сервер
  // мержит вложенные патчи по полям, но полный объект не теряет значения
  // config.yaml при первом сохранении). Неизменённые поля берутся из сохранённых
  // настроек — иначе MiB→байты терял бы точность округления.
  body.compression = {
    enabled: draft.compressionEnabled,
    image: {
      enabled: draft.imageCompressionEnabled,
      maxSidePx: intFromDraft(
        draft.imageMaxSide,
        saved.imageMaxSide,
        savedSettings.compression.image.maxSidePx,
      ),
      quality: intFromDraft(
        draft.imageQuality,
        saved.imageQuality,
        savedSettings.compression.image.quality,
      ),
      minBytes: mibFromDraft(
        draft.imageMinMiB,
        saved.imageMinMiB,
        savedSettings.compression.image.minBytes,
      ),
    },
    video: {
      enabled: draft.videoCompressionEnabled,
      maxHeightPx: intFromDraft(
        draft.videoMaxHeight,
        saved.videoMaxHeight,
        savedSettings.compression.video.maxHeightPx,
      ),
      bitrateKbps: intFromDraft(
        draft.videoBitrateKbps,
        saved.videoBitrateKbps,
        savedSettings.compression.video.bitrateKbps,
      ),
      audioBitrateKbps: intFromDraft(
        draft.videoAudioBitrateKbps,
        saved.videoAudioBitrateKbps,
        savedSettings.compression.video.audioBitrateKbps,
      ),
      minBytes: mibFromDraft(
        draft.videoMinMiB,
        saved.videoMinMiB,
        savedSettings.compression.video.minBytes,
      ),
    },
    audio: {
      enabled: draft.audioCompressionEnabled,
      bitrateKbps: intFromDraft(
        draft.audioBitrateKbps,
        saved.audioBitrateKbps,
        savedSettings.compression.audio.bitrateKbps,
      ),
      channels: intFromDraft(
        draft.audioChannels,
        saved.audioChannels,
        savedSettings.compression.audio.channels,
      ),
      sampleRateHz: intFromDraft(
        draft.audioSampleRate,
        saved.audioSampleRate,
        savedSettings.compression.audio.sampleRateHz,
      ),
      minBytes: mibFromDraft(
        draft.audioMinMiB,
        saved.audioMinMiB,
        savedSettings.compression.audio.minBytes,
      ),
    },
  }
  body.thumbnail = {
    enabled: draft.thumbnailEnabled,
    maxWidthPx: intFromDraft(
      draft.thumbnailMaxWidth,
      saved.thumbnailMaxWidth,
      savedSettings.thumbnail.maxWidthPx,
    ),
  }
  body.maxChunkBytes = mibFromDraft(
    draft.maxChunkMiB,
    saved.maxChunkMiB,
    savedSettings.maxChunkBytes,
  )
  body.maxActiveUploadsPerSession = intFromDraft(
    draft.maxActiveUploadsPerSession,
    saved.maxActiveUploadsPerSession,
    savedSettings.maxActiveUploadsPerSession,
  )
  body.maxActiveUploads = intFromDraft(
    draft.maxActiveUploads,
    saved.maxActiveUploads,
    savedSettings.maxActiveUploads,
  )

  for (const field of ATTACHMENTS_FIELDS) {
    if (isEnvLockedField(envLocked, field)) delete body[field]
  }
  return body
}

/** Ошибки валидации формы — i18n-ключи по полям (пусто — форма валидна). */
export interface AttachmentsFormErrors {
  maxFileMiB?: string
  maxFilesPerMessage?: string
  maxSessionMiB?: string
  gcDays?: string
  mime?: string
  maxChunkMiB?: string
  maxActiveUploadsPerSession?: string
  maxActiveUploads?: string
  imageMaxSide?: string
  imageQuality?: string
  imageMinMiB?: string
  videoMaxHeight?: string
  videoBitrateKbps?: string
  videoAudioBitrateKbps?: string
  videoMinMiB?: string
  audioBitrateKbps?: string
  audioChannels?: string
  audioSampleRate?: string
  audioMinMiB?: string
  thumbnailMaxWidth?: string
}

/** Целое в диапазоне [min, max] (диапазоны — как в схеме `attachments`). */
function isIntInRange(value: string, min: number, max: number): boolean {
  const parsed = parseIntField(value)
  return parsed !== null && parsed >= min && parsed <= max
}

/** Неотрицательное число MiB (порог сжатия: `0` — сжимать всё). */
function isMiBAtLeastZero(value: string): boolean {
  return mibToBytes(value) !== null
}

/** Валидация черновика: непустые/целые числа, диапазоны схемы и MIME-список. */
export function validateAttachmentsForm(form: AttachmentsForm): AttachmentsFormErrors {
  const errors: AttachmentsFormErrors = {}
  // Сервер принимает лимиты только целыми байтами ≥ 1 (MiB → байты с округлением).
  const fileBytes = mibToBytes(form.maxFileMiB)
  if (fileBytes === null || fileBytes < 1) {
    errors.maxFileMiB = 'settings.attachments.limits.fileInvalid'
  }
  const files = parseIntField(form.maxFilesPerMessage)
  if (files === null || files < 1) {
    errors.maxFilesPerMessage = 'settings.attachments.limits.filesInvalid'
  }
  const sessionBytes = mibToBytes(form.maxSessionMiB)
  if (sessionBytes === null || sessionBytes < 1) {
    errors.maxSessionMiB = 'settings.attachments.limits.sessionInvalid'
  }
  if (parseIntField(form.gcDays) === null) {
    errors.gcDays = 'settings.attachments.storage.invalid'
  }
  if (parseMimePrefixes(form.mimePrefixes).hasEmpty) {
    errors.mime = 'settings.attachments.mime.empty'
  }
  // ADR-115: chunked-загрузка — не меньше 1 КиБ.
  const chunkBytes = mibToBytes(form.maxChunkMiB)
  if (chunkBytes === null || chunkBytes < 1024) {
    errors.maxChunkMiB = 'settings.attachments.limits.chunkInvalid'
  }
  // ADR-115: пределы активных загрузок — целые > 0 (как в схеме `attachments`).
  if (!isIntInRange(form.maxActiveUploadsPerSession, 1, Number.MAX_SAFE_INTEGER)) {
    errors.maxActiveUploadsPerSession = 'settings.attachments.limits.activeUploadsInvalid'
  }
  if (!isIntInRange(form.maxActiveUploads, 1, Number.MAX_SAFE_INTEGER)) {
    errors.maxActiveUploads = 'settings.attachments.limits.activeUploadsInvalid'
  }
  // ADR-115: диапазоны сжатия/миниатюр — те же, что в Zod-схеме.
  if (!isIntInRange(form.imageMaxSide, 64, 8192)) {
    errors.imageMaxSide = 'settings.attachments.compression.imageSideInvalid'
  }
  if (!isIntInRange(form.imageQuality, 1, 100)) {
    errors.imageQuality = 'settings.attachments.compression.imageQualityInvalid'
  }
  if (!isMiBAtLeastZero(form.imageMinMiB)) {
    errors.imageMinMiB = 'settings.attachments.compression.minSizeInvalid'
  }
  if (!isIntInRange(form.videoMaxHeight, 144, 4320)) {
    errors.videoMaxHeight = 'settings.attachments.compression.videoHeightInvalid'
  }
  if (!isIntInRange(form.videoBitrateKbps, 100, 50000)) {
    errors.videoBitrateKbps = 'settings.attachments.compression.videoBitrateInvalid'
  }
  if (!isIntInRange(form.videoAudioBitrateKbps, 16, 512)) {
    errors.videoAudioBitrateKbps = 'settings.attachments.compression.videoAudioBitrateInvalid'
  }
  if (!isMiBAtLeastZero(form.videoMinMiB)) {
    errors.videoMinMiB = 'settings.attachments.compression.minSizeInvalid'
  }
  if (!isIntInRange(form.audioBitrateKbps, 8, 512)) {
    errors.audioBitrateKbps = 'settings.attachments.compression.audioBitrateInvalid'
  }
  if (!isIntInRange(form.audioChannels, 1, 2)) {
    errors.audioChannels = 'settings.attachments.compression.audioChannelsInvalid'
  }
  if (!isIntInRange(form.audioSampleRate, 8000, 48000)) {
    errors.audioSampleRate = 'settings.attachments.compression.audioSampleRateInvalid'
  }
  if (!isMiBAtLeastZero(form.audioMinMiB)) {
    errors.audioMinMiB = 'settings.attachments.compression.minSizeInvalid'
  }
  if (!isIntInRange(form.thumbnailMaxWidth, 64, 1024)) {
    errors.thumbnailMaxWidth = 'settings.attachments.thumbnail.widthInvalid'
  }
  return errors
}

/** Список включённых модальностей «работающего» набора — для строки статуса. */
function runningModalities(settings: AttachmentsSettings): string {
  const keys: Array<keyof AttachmentsSettings['modalities']> = ['image', 'pdf', 'audio', 'video']
  const enabled = keys.filter((key) => settings.modalities[key])
  if (enabled.length === 0) return '—'
  return enabled.join(', ')
}

/**
 * ADR-115 / ADR-072: админ-раздел «Мультимодальный ввод» — runtime-настройки
 * вложений сообщений (`GET/PUT/DELETE /settings/attachments`): мастер-выключатель,
 * поддерживаемые модальности, модели обработки по модальностям (`modalityModels`),
 * лимиты размера/количества, срок хранения осиротевших файлов, сохранение
 * несовместимых вложений в рабочий каталог и белый список MIME. Мутации — ADMIN
 * (guard сервера).
 *
 * Поля из `envLocked` в UI недоступны и в тело PUT не попадают: значение задано
 * через env и переопределяется только там. Изменения применяются сразу
 * (`restartRequired` для вложений — `false`).
 */
export function MultimodalSettings() {
  const { t } = useI18n()
  const { notify } = useNotification()
  const catalogModels = useCatalogModels()
  // Провайдеры нужны, чтобы не предлагать aux-модели отключённых провайдеров.
  const providers = useProvidersStore((s) => s.providers)
  const loadProviders = useProvidersStore((s) => s.loadProviders)
  useEffect(() => {
    if (providers.length === 0) void loadProviders()
  }, [providers.length, loadProviders])
  const selectableCatalog = useMemo(() => {
    const providersByName = selectableProvidersByName(providers)
    return catalogModels.filter((m) => isSelectableModel(m, providersByName))
  }, [catalogModels, providers])

  const [info, setInfo] = useState<AttachmentsSettingsInfo | null>(null)
  const [defaults, setDefaults] = useState<AttachmentsSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const savedForm = useMemo(
    () => (info ? formFromAttachments(info.attachments) : null),
    [info],
  )
  const defaultForm = useMemo(
    () => (defaults ? formFromAttachments(defaults) : null),
    [defaults],
  )

  const draft = useSettingsDraft<AttachmentsForm>({
    value: savedForm,
    defaultValue: defaultForm,
  })

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const res = await synthApi.getAttachmentsSettings()
      setInfo(res)
      setDefaults(res.defaults)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : t('settings.attachments.loadError'))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    void load()
  }, [load])

  const modalityOptions = useMemo(() => {
    const byFamily = {} as Record<ModalityFamily, ModalityModelOption[]>
    for (const family of MODALITY_FAMILIES) {
      byFamily[family] = modelsForModality(selectableCatalog, family)
    }
    return byFamily
  }, [selectableCatalog])

  // Каталог моделей постраничный: назначенная aux-модель может быть не на
  // загруженной странице — догружаем её, иначе она не попадёт в список
  // выбора (и «несовместимая» подсказка сработает неверно).
  const modalityDraft = draft.draft
  useEnsureModelsLoaded(
    MODALITY_FAMILIES.map((family) => {
      const ref = modalityDraft?.modalityModels?.[family]
      return ref?.provider && ref?.model ? `${ref.provider}/${ref.model}` : null
    }),
  )

  const envLocked = info?.envLocked ?? []
  const locked = useCallback(
    (field: string) => isEnvLockedField(envLocked, field),
    [envLocked],
  )

  const current = draft.draft
  const errors = current ? validateAttachmentsForm(current) : {}
  const hasErrors = Object.keys(errors).length > 0

  const handleSave = useCallback(async () => {
    if (!draft.draft || !draft.saved || !info || hasErrors) return
    const body = buildAttachmentsBody(
      draft.draft,
      draft.saved,
      info.attachments,
      envLocked,
    )
    // Все поля зафиксированы env — отправлять нечего.
    if (Object.keys(body).length === 0) return
    setSaving(true)
    try {
      const res = await synthApi.updateAttachmentsSettings(body)
      setInfo(res)
      setDefaults(res.defaults)
      draft.setDraft(formFromAttachments(res.attachments))
      notify({ text: t('settings.attachments.saved'), type: 'success', category: 'system' })
    } catch (err) {
      notify({
        text: t('settings.attachments.saveError', {
          error: err instanceof Error ? err.message : t('common.error'),
        }),
        type: 'error',
        category: 'error',
      })
    } finally {
      setSaving(false)
    }
  }, [draft, envLocked, hasErrors, info, notify, t])

  const handleReset = useCallback(async () => {
    setSaving(true)
    try {
      const res = await synthApi.resetAttachmentsSettings()
      setInfo(res)
      setDefaults(res.defaults)
      draft.setDraft(formFromAttachments(res.attachments))
      notify({ text: t('settings.attachments.saved'), type: 'success', category: 'system' })
    } catch (err) {
      notify({
        text: t('settings.attachments.saveError', {
          error: err instanceof Error ? err.message : t('common.error'),
        }),
        type: 'error',
        category: 'error',
      })
    } finally {
      setSaving(false)
    }
  }, [draft, notify, t])

  const source = info?.source ?? 'default'
  const running = info?.running ?? null

  return (
    <SettingsPanel
      title={t('settings.attachments.title')}
      description={t('settings.attachments.description')}
    >
      {/* 1. Состояние: источник, признак runtime-override, что работает сейчас */}
      <SettingsSection
        id="attachments-status"
        title={t('settings.attachments.status.title')}
        description={t('settings.attachments.status.description')}
        tooltip={t('settings.help.attachments.section.attachments-status')}
      >
        {loadError && (
          <div
            role="alert"
            data-testid="attachments-load-error"
            className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive"
          >
            {loadError}
          </div>
        )}

        {loading && !info && (
          <div className="py-3 text-center text-xs text-muted-foreground">{t('common.loading')}</div>
        )}

        {info && (
          <>
            <div
              className="flex flex-wrap items-center gap-1.5 min-w-0"
              data-testid="attachments-badges"
            >
              <span
                data-testid="attachments-source-badge"
                className={cn(BADGE, SOURCE_BADGE_CLASS[source])}
              >
                {t(`settings.attachments.source.${source}`)}
              </span>
              {info.isOverridden && (
                <span
                  data-testid="attachments-overridden-badge"
                  className={cn(BADGE, 'bg-primary/15 text-primary')}
                >
                  {t('settings.attachments.status.overridden')}
                </span>
              )}
              <span
                data-testid="attachments-running-badge"
                className={cn(
                  BADGE,
                  running?.enabled
                    ? 'bg-status-success/15 text-status-success'
                    : 'bg-muted text-muted-foreground',
                )}
              >
                {running?.enabled
                  ? t('settings.attachments.state.enabled')
                  : t('settings.attachments.state.disabled')}
              </span>
            </div>

            <div className="space-y-1.5 min-w-0" data-testid="attachments-status">
              <InfoField
                label={t('settings.attachments.status.source')}
                value={t(`settings.attachments.source.${source}`)}
              />
              <InfoField
                label={t('settings.attachments.status.running')}
                value={
                  running?.enabled
                    ? t('settings.attachments.state.enabled')
                    : t('settings.attachments.state.disabled')
                }
              />
              <InfoField
                label={t('settings.attachments.status.runningModalities')}
                value={running ? runningModalities(running) : '—'}
                mono
              />
            </div>

            {info.restartRequired && (
              <div
                data-testid="attachments-restart-required"
                className="flex items-start gap-2 rounded-lg bg-status-warning/10 p-3 text-xs text-status-warning min-w-0"
              >
                <Icon name="refresh" className="mt-0.5 size-3.5 shrink-0" />
                <span className="min-w-0 break-words">{t('settings.attachments.restartRequired')}</span>
              </div>
            )}
          </>
        )}
      </SettingsSection>

      {/* 2. Мастер-выключатель */}
      <SettingsSection
        id="attachments-general"
        title={t('settings.attachments.general.title')}
        description={t('settings.attachments.general.description')}
        tooltip={t('settings.help.attachments.section.attachments-general')}
      >
        {current && (
          <>
            <ToggleField
              label={t('settings.attachments.enabled.label')}
              description={t('settings.attachments.enabled.hint')}
              tooltip={t('settings.help.attachments.enabled')}
              enabled={current.enabled}
              disabled={locked('enabled')}
              onToggle={() => draft.update({ enabled: !current.enabled })}
              ariaLabel={t('settings.attachments.enabled.label')}
            />
            {locked('enabled') && (
              <p
                data-testid="attachments-env-locked"
                className="text-xs text-status-warning break-words"
              >
                {t('settings.attachments.envLocked')}
              </p>
            )}
          </>
        )}
      </SettingsSection>

      {/* 3. Поддерживаемые модальности */}
      <SettingsSection
        id="attachments-modalities"
        title={t('settings.attachments.modalities.title')}
        description={t('settings.attachments.modalities.description')}
        tooltip={t('settings.help.attachments.section.attachments-modalities')}
      >
        {current && (
          <>
            <ToggleField
              label={t('settings.attachments.modalities.image')}
              description={t('settings.attachments.modalities.imageHint')}
              enabled={current.image}
              disabled={locked('modalities.image')}
              onToggle={() => draft.update({ image: !current.image })}
              ariaLabel={t('settings.attachments.modalities.image')}
            />
            <ToggleField
              label={t('settings.attachments.modalities.pdf')}
              description={t('settings.attachments.modalities.pdfHint')}
              enabled={current.pdf}
              disabled={locked('modalities.pdf')}
              onToggle={() => draft.update({ pdf: !current.pdf })}
              ariaLabel={t('settings.attachments.modalities.pdf')}
            />
            <ToggleField
              label={t('settings.attachments.modalities.audio')}
              description={t('settings.attachments.modalities.audioHint')}
              enabled={current.audio}
              disabled={locked('modalities.audio')}
              onToggle={() => draft.update({ audio: !current.audio })}
              ariaLabel={t('settings.attachments.modalities.audio')}
            />
            <ToggleField
              label={t('settings.attachments.modalities.video')}
              description={t('settings.attachments.modalities.videoHint')}
              enabled={current.video}
              disabled={locked('modalities.video')}
              onToggle={() => draft.update({ video: !current.video })}
              ariaLabel={t('settings.attachments.modalities.video')}
            />
          </>
        )}
      </SettingsSection>

      {/* 4. Модели по модальностям: aux-модели обработки вложений (ADR-115) */}
      <SettingsSection
        id="attachments-modality-models"
        title={t('settings.attachments.modalityModels.title')}
        description={t('settings.attachments.modalityModels.description')}
        tooltip={t('settings.help.attachments.section.attachments-modality-models')}
      >
        {current && (
          <>
            {MODALITY_FAMILIES.map((family) => {
              const options = modalityOptions[family]
              const selected = current.modalityModels[family]
              const selectedKey = selected ? modalityModelKey(selected) : NOT_SET_MODALITY_MODEL
              const offered = options.some((option) => option.key === selectedKey)
              const items = [
                {
                  value: NOT_SET_MODALITY_MODEL,
                  label: t('settings.attachments.modalityModels.none'),
                },
                ...options.map((option) => ({ value: option.key, label: option.label })),
              ]
              return (
                <div
                  key={family}
                  className="min-w-0"
                  data-testid={`attachments-modality-row-${family}`}
                >
                  <SelectField
                    label={t(`settings.attachments.modalityModels.${family}`)}
                    tooltip={t(`settings.help.attachments.modalityModels.${family}`)}
                    value={selectedKey}
                    onValueChange={(value) => {
                      const next = options.find((option) => option.key === value)
                      draft.update({
                        modalityModels: {
                          ...current.modalityModels,
                          [family]: next ? next.ref : null,
                        },
                      })
                    }}
                    disabled={locked('modalityModels')}
                    ariaLabel={t(`settings.attachments.modalityModels.${family}`)}
                    triggerTestId={`attachments-modality-${family}`}
                    items={items}
                  >
                    <SelectContent>
                      {items.map((item) => (
                        <SelectItem key={item.value} value={item.value}>
                          {item.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </SelectField>

                  {/* Каталог загружен, но назначенная модель не заявляет эту модальность
                      (модель отключена/без `modalities`) — сервер отклонит сохранение. */}
                  {selected && !offered && catalogModels.length > 0 && (
                    <p
                      data-testid={`attachments-modality-warning-${family}`}
                      className="text-xs text-status-warning break-words"
                    >
                      {t('settings.attachments.modalityModels.incompatible', { model: selectedKey })}
                    </p>
                  )}
                </div>
              )
            })}

            <p className="text-xs text-muted-foreground break-words" data-testid="attachments-modality-hint">
              {t('settings.attachments.modalityModels.hint')}
            </p>

            {locked('modalityModels') && (
              <p
                data-testid="attachments-modality-env-locked"
                className="text-xs text-status-warning break-words"
              >
                {t('settings.attachments.envLocked')}
              </p>
            )}
          </>
        )}
      </SettingsSection>

      {/* 5. Сжатие перед отправкой провайдеру (ADR-115) */}
      <SettingsSection
        id="attachments-compression"
        title={t('settings.attachments.compression.title')}
        description={t('settings.attachments.compression.description')}
        tooltip={t('settings.help.attachments.section.attachments-compression')}
      >
        {current && (
          <>
            <ToggleField
              label={t('settings.attachments.compression.enabled')}
              description={t('settings.attachments.compression.enabledHint')}
              tooltip={t('settings.help.attachments.compression.enabled')}
              enabled={current.compressionEnabled}
              disabled={locked('compression')}
              onToggle={() => draft.update({ compressionEnabled: !current.compressionEnabled })}
              ariaLabel={t('settings.attachments.compression.enabled')}
            />

            {locked('compression') && (
              <p
                data-testid="attachments-compression-env-locked"
                className="text-xs text-status-warning break-words"
              >
                {t('settings.attachments.envLocked')}
              </p>
            )}

            {/* Картинки */}
            <div className="space-y-1.5 min-w-0 border-t border-border pt-3">
              <p className="text-xs font-medium text-muted-foreground">
                {t('settings.attachments.compression.image.title')}
              </p>
              <ToggleField
                label={t('settings.attachments.compression.image.enabled')}
                enabled={current.imageCompressionEnabled}
                disabled={!current.compressionEnabled || locked('compression.image')}
                onToggle={() =>
                  draft.update({ imageCompressionEnabled: !current.imageCompressionEnabled })
                }
                ariaLabel={t('settings.attachments.compression.image.enabled')}
              />
              <NumberField
                label={t('settings.attachments.compression.image.maxSide')}
                tooltip={t('settings.help.attachments.compression.image.maxSide')}
                min={64}
                max={8192}
                step={1}
                suffix={t('settings.attachments.unitPx')}
                value={current.imageMaxSide}
                onChange={(e) => draft.update({ imageMaxSide: e.target.value })}
                error={errors.imageMaxSide ? t(errors.imageMaxSide) : undefined}
                disabled={!current.compressionEnabled || !current.imageCompressionEnabled || locked('compression.image')}
                id="attachments-image-max-side"
                data-testid="attachments-image-max-side"
              />
              <NumberField
                label={t('settings.attachments.compression.image.quality')}
                tooltip={t('settings.help.attachments.compression.image.quality')}
                min={1}
                max={100}
                step={1}
                value={current.imageQuality}
                onChange={(e) => draft.update({ imageQuality: e.target.value })}
                error={errors.imageQuality ? t(errors.imageQuality) : undefined}
                disabled={!current.compressionEnabled || !current.imageCompressionEnabled || locked('compression.image')}
                id="attachments-image-quality"
                data-testid="attachments-image-quality"
              />
              <NumberField
                label={t('settings.attachments.compression.image.minSize')}
                tooltip={t('settings.help.attachments.compression.image.minSize')}
                min={0}
                step={0.01}
                suffix={t('settings.attachments.unitMiB')}
                value={current.imageMinMiB}
                onChange={(e) => draft.update({ imageMinMiB: e.target.value })}
                error={errors.imageMinMiB ? t(errors.imageMinMiB) : undefined}
                disabled={!current.compressionEnabled || !current.imageCompressionEnabled || locked('compression.image')}
                id="attachments-image-min"
                data-testid="attachments-image-min"
              />
            </div>

            {/* Видео */}
            <div className="space-y-1.5 min-w-0 border-t border-border pt-3">
              <p className="text-xs font-medium text-muted-foreground">
                {t('settings.attachments.compression.video.title')}
              </p>
              <ToggleField
                label={t('settings.attachments.compression.video.enabled')}
                enabled={current.videoCompressionEnabled}
                disabled={!current.compressionEnabled || locked('compression.video')}
                onToggle={() =>
                  draft.update({ videoCompressionEnabled: !current.videoCompressionEnabled })
                }
                ariaLabel={t('settings.attachments.compression.video.enabled')}
              />
              <NumberField
                label={t('settings.attachments.compression.video.maxHeight')}
                tooltip={t('settings.help.attachments.compression.video.maxHeight')}
                min={144}
                max={4320}
                step={1}
                suffix={t('settings.attachments.unitPx')}
                value={current.videoMaxHeight}
                onChange={(e) => draft.update({ videoMaxHeight: e.target.value })}
                error={errors.videoMaxHeight ? t(errors.videoMaxHeight) : undefined}
                disabled={!current.compressionEnabled || !current.videoCompressionEnabled || locked('compression.video')}
                id="attachments-video-max-height"
                data-testid="attachments-video-max-height"
              />
              <NumberField
                label={t('settings.attachments.compression.video.bitrate')}
                tooltip={t('settings.help.attachments.compression.video.bitrate')}
                min={100}
                max={50000}
                step={1}
                suffix={t('settings.attachments.unitKbps')}
                value={current.videoBitrateKbps}
                onChange={(e) => draft.update({ videoBitrateKbps: e.target.value })}
                error={errors.videoBitrateKbps ? t(errors.videoBitrateKbps) : undefined}
                disabled={!current.compressionEnabled || !current.videoCompressionEnabled || locked('compression.video')}
                id="attachments-video-bitrate"
                data-testid="attachments-video-bitrate"
              />
              <NumberField
                label={t('settings.attachments.compression.video.audioBitrate')}
                tooltip={t('settings.help.attachments.compression.video.audioBitrate')}
                min={16}
                max={512}
                step={1}
                suffix={t('settings.attachments.unitKbps')}
                value={current.videoAudioBitrateKbps}
                onChange={(e) => draft.update({ videoAudioBitrateKbps: e.target.value })}
                error={errors.videoAudioBitrateKbps ? t(errors.videoAudioBitrateKbps) : undefined}
                disabled={!current.compressionEnabled || !current.videoCompressionEnabled || locked('compression.video')}
                id="attachments-video-audio-bitrate"
                data-testid="attachments-video-audio-bitrate"
              />
              <NumberField
                label={t('settings.attachments.compression.video.minSize')}
                tooltip={t('settings.help.attachments.compression.video.minSize')}
                min={0}
                step={0.01}
                suffix={t('settings.attachments.unitMiB')}
                value={current.videoMinMiB}
                onChange={(e) => draft.update({ videoMinMiB: e.target.value })}
                error={errors.videoMinMiB ? t(errors.videoMinMiB) : undefined}
                disabled={!current.compressionEnabled || !current.videoCompressionEnabled || locked('compression.video')}
                id="attachments-video-min"
                data-testid="attachments-video-min"
              />
            </div>

            {/* Аудио */}
            <div className="space-y-1.5 min-w-0 border-t border-border pt-3">
              <p className="text-xs font-medium text-muted-foreground">
                {t('settings.attachments.compression.audio.title')}
              </p>
              <ToggleField
                label={t('settings.attachments.compression.audio.enabled')}
                enabled={current.audioCompressionEnabled}
                disabled={!current.compressionEnabled || locked('compression.audio')}
                onToggle={() =>
                  draft.update({ audioCompressionEnabled: !current.audioCompressionEnabled })
                }
                ariaLabel={t('settings.attachments.compression.audio.enabled')}
              />
              <NumberField
                label={t('settings.attachments.compression.audio.bitrate')}
                tooltip={t('settings.help.attachments.compression.audio.bitrate')}
                min={8}
                max={512}
                step={1}
                suffix={t('settings.attachments.unitKbps')}
                value={current.audioBitrateKbps}
                onChange={(e) => draft.update({ audioBitrateKbps: e.target.value })}
                error={errors.audioBitrateKbps ? t(errors.audioBitrateKbps) : undefined}
                disabled={!current.compressionEnabled || !current.audioCompressionEnabled || locked('compression.audio')}
                id="attachments-audio-bitrate"
                data-testid="attachments-audio-bitrate"
              />
              <NumberField
                label={t('settings.attachments.compression.audio.channels')}
                tooltip={t('settings.help.attachments.compression.audio.channels')}
                min={1}
                max={2}
                step={1}
                value={current.audioChannels}
                onChange={(e) => draft.update({ audioChannels: e.target.value })}
                error={errors.audioChannels ? t(errors.audioChannels) : undefined}
                disabled={!current.compressionEnabled || !current.audioCompressionEnabled || locked('compression.audio')}
                id="attachments-audio-channels"
                data-testid="attachments-audio-channels"
              />
              <NumberField
                label={t('settings.attachments.compression.audio.sampleRate')}
                tooltip={t('settings.help.attachments.compression.audio.sampleRate')}
                min={8000}
                max={48000}
                step={1}
                suffix={t('settings.attachments.unitHz')}
                value={current.audioSampleRate}
                onChange={(e) => draft.update({ audioSampleRate: e.target.value })}
                error={errors.audioSampleRate ? t(errors.audioSampleRate) : undefined}
                disabled={!current.compressionEnabled || !current.audioCompressionEnabled || locked('compression.audio')}
                id="attachments-audio-sample-rate"
                data-testid="attachments-audio-sample-rate"
              />
              <NumberField
                label={t('settings.attachments.compression.audio.minSize')}
                tooltip={t('settings.help.attachments.compression.audio.minSize')}
                min={0}
                step={0.01}
                suffix={t('settings.attachments.unitMiB')}
                value={current.audioMinMiB}
                onChange={(e) => draft.update({ audioMinMiB: e.target.value })}
                error={errors.audioMinMiB ? t(errors.audioMinMiB) : undefined}
                disabled={!current.compressionEnabled || !current.audioCompressionEnabled || locked('compression.audio')}
                id="attachments-audio-min"
                data-testid="attachments-audio-min"
              />
            </div>
          </>
        )}
      </SettingsSection>

      {/* 6. Серверные миниатюры для UI (ADR-115) */}
      <SettingsSection
        id="attachments-thumbnail"
        title={t('settings.attachments.thumbnail.title')}
        description={t('settings.attachments.thumbnail.description')}
        tooltip={t('settings.help.attachments.section.attachments-thumbnail')}
      >
        {current && (
          <>
            <ToggleField
              label={t('settings.attachments.thumbnail.enabled')}
              description={t('settings.attachments.thumbnail.enabledHint')}
              enabled={current.thumbnailEnabled}
              disabled={locked('thumbnail')}
              onToggle={() => draft.update({ thumbnailEnabled: !current.thumbnailEnabled })}
              ariaLabel={t('settings.attachments.thumbnail.enabled')}
            />
            <NumberField
              label={t('settings.attachments.thumbnail.maxWidth')}
              tooltip={t('settings.help.attachments.thumbnail.maxWidth')}
              min={64}
              max={1024}
              step={1}
              suffix={t('settings.attachments.unitPx')}
              value={current.thumbnailMaxWidth}
              onChange={(e) => draft.update({ thumbnailMaxWidth: e.target.value })}
              error={errors.thumbnailMaxWidth ? t(errors.thumbnailMaxWidth) : undefined}
              disabled={!current.thumbnailEnabled || locked('thumbnail')}
              id="attachments-thumbnail-max-width"
              data-testid="attachments-thumbnail-max-width"
            />
            {locked('thumbnail') && (
              <p
                data-testid="attachments-thumbnail-env-locked"
                className="text-xs text-status-warning break-words"
              >
                {t('settings.attachments.envLocked')}
              </p>
            )}
          </>
        )}
      </SettingsSection>

      {/* 7. Лимиты: размер файла/сессии в MiB (в API — байты), файлов в сообщении */}
      <SettingsSection
        id="attachments-limits"
        title={t('settings.attachments.limits.title')}
        description={t('settings.attachments.limits.description')}
        tooltip={t('settings.help.attachments.section.attachments-limits')}
      >
        {current && (
          <>
            <NumberField
              label={t('settings.attachments.limits.maxFile')}
              description={t('settings.attachments.limits.maxFileHint')}
              tooltip={t('settings.help.attachments.maxFile')}
              step={1}
              suffix={t('settings.attachments.unitMiB')}
              value={current.maxFileMiB}
              onChange={(e) => draft.update({ maxFileMiB: e.target.value })}
              error={errors.maxFileMiB ? t(errors.maxFileMiB) : undefined}
              disabled={locked('maxBytesPerFile')}
              id="attachments-max-file"
              data-testid="attachments-max-file"
            />
            <NumberField
              label={t('settings.attachments.limits.maxFiles')}
              description={t('settings.attachments.limits.maxFilesHint')}
              tooltip={t('settings.help.attachments.maxFiles')}
              min={1}
              step={1}
              value={current.maxFilesPerMessage}
              onChange={(e) => draft.update({ maxFilesPerMessage: e.target.value })}
              error={errors.maxFilesPerMessage ? t(errors.maxFilesPerMessage) : undefined}
              disabled={locked('maxFilesPerMessage')}
              id="attachments-max-files"
              data-testid="attachments-max-files"
            />
            <NumberField
              label={t('settings.attachments.limits.maxSession')}
              description={t('settings.attachments.limits.maxSessionHint')}
              tooltip={t('settings.help.attachments.maxSession')}
              step={1}
              suffix={t('settings.attachments.unitMiB')}
              value={current.maxSessionMiB}
              onChange={(e) => draft.update({ maxSessionMiB: e.target.value })}
              error={errors.maxSessionMiB ? t(errors.maxSessionMiB) : undefined}
              disabled={locked('maxBytesPerSession')}
              id="attachments-max-session"
              data-testid="attachments-max-session"
            />
            <NumberField
              label={t('settings.attachments.limits.chunk')}
              description={t('settings.attachments.limits.chunkHint')}
              tooltip={t('settings.help.attachments.maxChunk')}
              min={0}
              step={0.01}
              suffix={t('settings.attachments.unitMiB')}
              value={current.maxChunkMiB}
              onChange={(e) => draft.update({ maxChunkMiB: e.target.value })}
              error={errors.maxChunkMiB ? t(errors.maxChunkMiB) : undefined}
              disabled={locked('maxChunkBytes')}
              id="attachments-max-chunk"
              data-testid="attachments-max-chunk"
            />
            <NumberField
              label={t('settings.attachments.limits.activePerSession')}
              description={t('settings.attachments.limits.activePerSessionHint')}
              tooltip={t('settings.help.attachments.maxActiveUploadsPerSession')}
              min={1}
              step={1}
              value={current.maxActiveUploadsPerSession}
              onChange={(e) =>
                draft.update({ maxActiveUploadsPerSession: e.target.value })
              }
              error={
                errors.maxActiveUploadsPerSession
                  ? t(errors.maxActiveUploadsPerSession)
                  : undefined
              }
              disabled={locked('maxActiveUploadsPerSession')}
              id="attachments-max-active-uploads-per-session"
              data-testid="attachments-max-active-uploads-per-session"
            />
            <NumberField
              label={t('settings.attachments.limits.activeTotal')}
              description={t('settings.attachments.limits.activeTotalHint')}
              tooltip={t('settings.help.attachments.maxActiveUploads')}
              min={1}
              step={1}
              value={current.maxActiveUploads}
              onChange={(e) => draft.update({ maxActiveUploads: e.target.value })}
              error={errors.maxActiveUploads ? t(errors.maxActiveUploads) : undefined}
              disabled={locked('maxActiveUploads')}
              id="attachments-max-active-uploads"
              data-testid="attachments-max-active-uploads"
            />
            {(locked('maxActiveUploadsPerSession') || locked('maxActiveUploads')) && (
              <p
                data-testid="attachments-active-uploads-env-locked"
                className="text-xs text-status-warning break-words"
              >
                {t('settings.attachments.envLocked')}
              </p>
            )}
          </>
        )}
      </SettingsSection>

      {/* 8. Хранение: срок жизни осиротевших вложений */}
      <SettingsSection
        id="attachments-storage"
        title={t('settings.attachments.storage.title')}
        description={t('settings.attachments.storage.description')}
        tooltip={t('settings.help.attachments.section.attachments-storage')}
      >
        {current && (
          <NumberField
            label={t('settings.attachments.storage.gcDays')}
            description={t('settings.attachments.storage.gcDaysHint')}
            tooltip={t('settings.help.attachments.gcDays')}
            min={0}
            step={1}
            suffix={t('settings.attachments.unitDays')}
            value={current.gcDays}
            onChange={(e) => draft.update({ gcDays: e.target.value })}
            error={errors.gcDays ? t(errors.gcDays) : undefined}
            disabled={locked('gcDays')}
            id="attachments-gc-days"
            data-testid="attachments-gc-days"
          />
        )}
      </SettingsSection>

      {/* 9. Поведение: несовместимые вложения → рабочий каталог */}
      <SettingsSection
        id="attachments-behavior"
        title={t('settings.attachments.behavior.title')}
        description={t('settings.attachments.behavior.description')}
        tooltip={t('settings.help.attachments.section.attachments-behavior')}
      >
        {current && (
          <ToggleField
            label={t('settings.attachments.behavior.workspaceFallback')}
            description={t('settings.attachments.behavior.workspaceFallbackHint')}
            tooltip={t('settings.help.attachments.workspaceFallback')}
            enabled={current.workspaceFallback}
            disabled={locked('workspaceFallback')}
            onToggle={() => draft.update({ workspaceFallback: !current.workspaceFallback })}
            ariaLabel={t('settings.attachments.behavior.workspaceFallback')}
          />
        )}
      </SettingsSection>

      {/* 10. Белый список MIME + действия черновика */}
      <SettingsSection
        id="attachments-mime"
        title={t('settings.attachments.mime.title')}
        description={t('settings.attachments.mime.description')}
        tooltip={t('settings.help.attachments.section.attachments-mime')}
      >
        {current && (
          <>
            <TextField
              label={t('settings.attachments.mime.label')}
              description={t('settings.attachments.mime.hint')}
              tooltip={t('settings.help.attachments.mime')}
              placeholder={t('settings.attachments.mime.placeholder')}
              value={current.mimePrefixes}
              onChange={(e) => draft.update({ mimePrefixes: e.target.value })}
              error={errors.mime ? t(errors.mime) : undefined}
              disabled={locked('allowedMimePrefixes')}
              mono
              id="attachments-mime"
              data-testid="attachments-mime"
            />

            <SettingsActions
              onSave={() => void handleSave()}
              onCancel={() => draft.revert()}
              onReset={() => void handleReset()}
              saving={saving}
              saveDisabled={loading || !draft.dirty || hasErrors}
              cancelDisabled={!draft.dirty}
              resetDisabled={loading}
              isDefault={draft.isDefault}
              saveTestId="attachments-save"
              cancelTestId="attachments-cancel"
              resetTestId="attachments-reset"
            />
          </>
        )}
      </SettingsSection>
    </SettingsPanel>
  )
}
