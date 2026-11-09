import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getInstanceCapabilities: vi.fn(),
}))

// `/meta` читается через `stores/instanceCapabilitiesStore` — единственную
// точку обращения клиента к `/api/v2/meta`.
vi.mock('@/lib/api/synthApi', () => ({
  synthApi: { getInstanceCapabilities: mocks.getInstanceCapabilities },
}))

import type { InstanceAttachmentCapabilities } from '@itphx/synth-shared/types'
import {
  DEFAULT_ATTACHMENT_LIMITS,
  MAX_FILE_BYTES,
  MAX_FILES_PER_MESSAGE,
  loadAttachmentLimits,
  normalizeAttachmentLimits,
  resetAttachmentLimitsCacheForTests,
} from './limits'

const SERVER_LIMITS: InstanceAttachmentCapabilities = {
  enabled: true,
  modalities: { image: true, pdf: false, audio: true, video: false },
  maxBytesPerFile: 25 * 1024 * 1024,
  maxFilesPerMessage: 3,
  maxBytesPerSession: 50 * 1024 * 1024,
}

beforeEach(() => {
  vi.clearAllMocks()
  resetAttachmentLimitsCacheForTests()
})

afterEach(() => {
  vi.useRealTimers()
  resetAttachmentLimitsCacheForTests()
})

describe('DEFAULT_ATTACHMENT_LIMITS', () => {
  it('включает вложения, все семейства и UX-фоллбеки', () => {
    expect(DEFAULT_ATTACHMENT_LIMITS.enabled).toBe(true)
    expect(DEFAULT_ATTACHMENT_LIMITS.modalities).toEqual({
      image: true,
      pdf: true,
      audio: true,
      video: true,
    })
    expect(DEFAULT_ATTACHMENT_LIMITS.maxBytesPerFile).toBe(MAX_FILE_BYTES)
    expect(DEFAULT_ATTACHMENT_LIMITS.maxFilesPerMessage).toBe(MAX_FILES_PER_MESSAGE)
    expect(DEFAULT_ATTACHMENT_LIMITS.maxBytesPerSession).toBe(1024 * 1024 * 1024)
  })
})

describe('normalizeAttachmentLimits', () => {
  it('пусто или отсутствие `attachments` → дефолт', () => {
    expect(normalizeAttachmentLimits(undefined)).toEqual(DEFAULT_ATTACHMENT_LIMITS)
    expect(normalizeAttachmentLimits(null)).toEqual(DEFAULT_ATTACHMENT_LIMITS)
  })

  it('принимает корректные значения сервера', () => {
    expect(normalizeAttachmentLimits(SERVER_LIMITS)).toEqual(SERVER_LIMITS)
  })

  it('частичный ответ дополняет дефолтами', () => {
    const partial = {
      maxBytesPerFile: 5 * 1024 * 1024,
      modalities: { video: false },
    } as unknown as InstanceAttachmentCapabilities

    expect(normalizeAttachmentLimits(partial)).toEqual({
      ...DEFAULT_ATTACHMENT_LIMITS,
      maxBytesPerFile: 5 * 1024 * 1024,
      modalities: { ...DEFAULT_ATTACHMENT_LIMITS.modalities, video: false },
    })
  })

  it('мусор в числах и булевых → дефолт', () => {
    const garbage = {
      enabled: 'yes',
      modalities: { image: 1, pdf: null, audio: undefined, video: 'no' },
      maxBytesPerFile: -1,
      maxFilesPerMessage: Number.NaN,
      maxBytesPerSession: 1.5,
    } as unknown as InstanceAttachmentCapabilities

    const limits = normalizeAttachmentLimits(garbage)
    expect(limits.enabled).toBe(true)
    expect(limits.modalities).toEqual(DEFAULT_ATTACHMENT_LIMITS.modalities)
    expect(limits.maxBytesPerFile).toBe(MAX_FILE_BYTES)
    expect(limits.maxFilesPerMessage).toBe(MAX_FILES_PER_MESSAGE)
    expect(limits.maxBytesPerSession).toBe(DEFAULT_ATTACHMENT_LIMITS.maxBytesPerSession)
  })

  it('ноль и Infinity не проходят как лимит', () => {
    const broken = {
      maxBytesPerFile: 0,
      maxFilesPerMessage: Number.POSITIVE_INFINITY,
    } as unknown as InstanceAttachmentCapabilities

    const limits = normalizeAttachmentLimits(broken)
    expect(limits.maxBytesPerFile).toBe(MAX_FILE_BYTES)
    expect(limits.maxFilesPerMessage).toBe(MAX_FILES_PER_MESSAGE)
  })
})

describe('loadAttachmentLimits', () => {
  it('возвращает лимиты сервера и кэширует их', async () => {
    mocks.getInstanceCapabilities.mockResolvedValue({ messageModel: 2, attachments: SERVER_LIMITS })

    await expect(loadAttachmentLimits()).resolves.toEqual(SERVER_LIMITS)
    await expect(loadAttachmentLimits()).resolves.toEqual(SERVER_LIMITS)
    expect(mocks.getInstanceCapabilities).toHaveBeenCalledTimes(1)
  })

  it('старый сервер без attachments → дефолт', async () => {
    mocks.getInstanceCapabilities.mockResolvedValue({ messageModel: 2 })

    await expect(loadAttachmentLimits()).resolves.toEqual(DEFAULT_ATTACHMENT_LIMITS)
  })

  it('дедуп одновременных вызовов', async () => {
    let resolve: ((value: unknown) => void) | undefined
    mocks.getInstanceCapabilities.mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r
        }),
    )

    const first = loadAttachmentLimits()
    const second = loadAttachmentLimits()
    resolve?.({ messageModel: 2, attachments: SERVER_LIMITS })

    await expect(first).resolves.toEqual(SERVER_LIMITS)
    await expect(second).resolves.toEqual(SERVER_LIMITS)
    expect(mocks.getInstanceCapabilities).toHaveBeenCalledTimes(1)
  })

  it('ошибка сети → дефолт и тоже кэшируется', async () => {
    mocks.getInstanceCapabilities.mockRejectedValue(new Error('network'))

    await expect(loadAttachmentLimits()).resolves.toEqual(DEFAULT_ATTACHMENT_LIMITS)
    await expect(loadAttachmentLimits()).resolves.toEqual(DEFAULT_ATTACHMENT_LIMITS)
    expect(mocks.getInstanceCapabilities).toHaveBeenCalledTimes(1)
  })

  it('кэш истекает через 60 секунд', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    mocks.getInstanceCapabilities.mockResolvedValue({ messageModel: 2, attachments: SERVER_LIMITS })

    await loadAttachmentLimits()
    vi.setSystemTime(new Date('2026-01-01T00:00:59Z'))
    await loadAttachmentLimits()
    expect(mocks.getInstanceCapabilities).toHaveBeenCalledTimes(1)

    vi.setSystemTime(new Date('2026-01-01T00:01:01Z'))
    await loadAttachmentLimits()
    expect(mocks.getInstanceCapabilities).toHaveBeenCalledTimes(2)
  })
})
