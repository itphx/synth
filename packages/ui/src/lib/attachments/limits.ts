// Лимиты вложений композера (ADR-115).
//
// Источник истины — серверные `attachments.*` (`GET /api/v2/meta` →
// `InstanceAttachmentCapabilities`). Константы ниже — UX-фоллбеки: они нужны
// до ответа сервера (первый рендер композера) и когда сервер старый/недоступен.

import type { InstanceAttachmentCapabilities } from '@itphx/synth-shared/types'
import { metaApi } from '@/lib/api/meta'

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

/** Кэш ответа сервера: лимиты меняются редко, спамить `/meta` незачем. */
const CACHE_TTL_MS = 60_000

let cached: { limits: AttachmentLimits; at: number } | null = null
let inflight: Promise<AttachmentLimits> | null = null

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
 * Эффективные лимиты инстанса с кэшем на 60 с и дедупом одновременных вызовов.
 *
 * Ошибка сети/старый сервер → значения по умолчанию (тоже кэшируются на TTL,
 * чтобы не дёргать `/meta` на каждый файл).
 */
export async function loadAttachmentLimits(): Promise<AttachmentLimits> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.limits
  if (inflight) return inflight

  inflight = (async () => {
    try {
      const capabilities = await metaApi.getInstanceCapabilities()
      const limits = normalizeAttachmentLimits(capabilities?.attachments)
      cached = { limits, at: Date.now() }
      return limits
    } catch {
      cached = { limits: DEFAULT_ATTACHMENT_LIMITS, at: Date.now() }
      return DEFAULT_ATTACHMENT_LIMITS
    } finally {
      inflight = null
    }
  })()

  return inflight
}

/** Сброс кэша между тестами (в рантайме не нужен). */
export function resetAttachmentLimitsCacheForTests(): void {
  cached = null
  inflight = null
}
