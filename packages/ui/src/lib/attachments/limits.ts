// Лимиты вложений композера (ADR-115).
//
// Источник истины — серверные `attachments.*` (`GET /api/v2/meta` →
// `InstanceAttachmentCapabilities`). Константы ниже — UX-фоллбеки: они нужны
// до ответа сервера (первый рендер композера) и когда сервер старый/недоступен.
//
// Ответ `/meta` берётся из `stores/instanceCapabilitiesStore` — это единственная
// точка обращения клиента к `/meta` (кэш 60 с + дедуп живут в сторе).

import type { InstanceAttachmentCapabilities } from '@itphx/synth-shared/types'
import { useInstanceCapabilitiesStore } from '@/stores/instanceCapabilitiesStore'

/** UX-фоллбек предела одного файла: 100 МиБ (паритет с серверным дефолтом). */
export const MAX_FILE_BYTES = 100 * 1024 * 1024

/** UX-фоллбек числа файлов в одном сообщении. */
export const MAX_FILES_PER_MESSAGE = 10

/** Лимиты вложений инстанса (структура серверная, поля аддитивны). */
export type AttachmentLimits = InstanceAttachmentCapabilities

/** Значения по умолчанию: вложения включены, все семейства разрешены. */
export const DEFAULT_ATTACHMENT_LIMITS: AttachmentLimits = {
  enabled: true,
  modalities: { image: true, pdf: true, audio: true, video: true },
  maxBytesPerFile: MAX_FILE_BYTES,
  maxFilesPerMessage: MAX_FILES_PER_MESSAGE,
  maxBytesPerSession: 1024 * 1024 * 1024,
}

function positiveInteger(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    return fallback
  }
  return value > 0 ? value : fallback
}

function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/**
 * Защитная нормализация ответа сервера: отсутствующие/битые поля заменяются
 * значениями по умолчанию, `attachments` нет вовсе (старый сервер) — дефолт.
 */
export function normalizeAttachmentLimits(
  caps?: InstanceAttachmentCapabilities | null,
): AttachmentLimits {
  if (!caps) return DEFAULT_ATTACHMENT_LIMITS

  const modalities = (caps.modalities ?? {}) as Partial<InstanceAttachmentCapabilities['modalities']>
  const defaults = DEFAULT_ATTACHMENT_LIMITS

  return {
    enabled: booleanOr(caps.enabled, defaults.enabled),
    modalities: {
      image: booleanOr(modalities.image, defaults.modalities.image),
      pdf: booleanOr(modalities.pdf, defaults.modalities.pdf),
      audio: booleanOr(modalities.audio, defaults.modalities.audio),
      video: booleanOr(modalities.video, defaults.modalities.video),
    },
    maxBytesPerFile: positiveInteger(caps.maxBytesPerFile, defaults.maxBytesPerFile),
    maxFilesPerMessage: positiveInteger(caps.maxFilesPerMessage, defaults.maxFilesPerMessage),
    maxBytesPerSession: positiveInteger(caps.maxBytesPerSession, defaults.maxBytesPerSession),
  }
}

/**
 * Эффективные лимиты инстанса.
 *
 * Ответ `/meta` берётся из `stores/instanceCapabilitiesStore` (единственная
 * точка обращения к `/meta`): там же кэш на 60 с и дедуп одновременных вызовов.
 *
 * Ошибка сети/старый сервер → значения по умолчанию (пустой ответ тоже
 * кэшируется на TTL — `/meta` не дёргается на каждый файл).
 */
export async function loadAttachmentLimits(): Promise<AttachmentLimits> {
  const capabilities = await useInstanceCapabilitiesStore.getState().load()
  return normalizeAttachmentLimits(capabilities?.attachments)
}

/** Сброс кэша между тестами (в рантайме не нужен). */
export function resetAttachmentLimitsCacheForTests(): void {
  useInstanceCapabilitiesStore.getState().resetForTests()
}
